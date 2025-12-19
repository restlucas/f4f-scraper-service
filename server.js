require("dotenv").config();
const fastify = require("fastify")({ logger: true });
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const SCRAPE_SECRET = process.env.SCRAPER_API_KEY;

fastify.get("/scrape", async (request, reply) => {
  const authHeader = request.headers["x-api-key"];

  if (!authHeader || authHeader !== SCRAPE_SECRET) {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  const { url } = request.query;
  if (!url) {
    return reply.status(400).send({ error: "URL é obrigatória" });
  }

  const decodedUrl = decodeURIComponent(url);

  // Launch com argumentos para estabilidade em Docker/Linux
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();

    // 1. Emular uma tela real
    await page.setViewport({ width: 1366, height: 768 });

    // 2. User Agent moderno
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // 3. Bloquear recursos inúteis (Anúncios/Imagens) para evitar timeout
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // 4. Navegação com estratégia menos exigente que networkidle2
    // O tracker.gg nunca fica "ocioso" por causa dos trackers de analytics
    await page.goto(decodedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // 5. Esperar o elemento chave com um tempo razoável
    await page.waitForSelector(".stat-name", { timeout: 30000 });

    // Pequena pausa para garantir que o JS do Tracker.gg rendarizou os números
    await new Promise((r) => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      function parseNumber(val) {
        if (!val) return 0;
        val = val.trim().replace(/,/g, "");
        if (val.endsWith("%")) return parseFloat(val.replace("%", ""));
        if (val.toLowerCase().endsWith("k"))
          return parseFloat(val.toLowerCase().replace("k", "")) * 1000;
        const num = parseFloat(val);
        return isNaN(num) ? 0 : num;
      }

      function parseTimeInMinutes(raw) {
        let minutes = 0;
        const h = raw.match(/(\d+)\s*h/);
        const m = raw.match(/(\d+)\s*m/);
        if (h) minutes += parseInt(h[1]) * 60;
        if (m) minutes += parseInt(m[1]);
        return minutes;
      }

      const finalData = {
        kills: 0,
        deaths: 0,
        wins: 0,
        losses: 0,
        hsPercent: 0,
        assists: 0,
        revives: 0,
        killDeath: 0,
        objectivesCaptured: 0,
        objectivesDestroyed: 0,
        bestClass: null,
        timePlayed: 0,
      };

      function getStatFromContainer(container, labelName) {
        if (!container) return null;
        const allStats = container.querySelectorAll(".stat-ver, .stat-hor");
        for (const stat of allStats) {
          const name = stat
            .querySelector(".stat-name")
            ?.textContent.trim()
            .toLowerCase();
          if (name === labelName.toLowerCase()) {
            return stat.querySelector(".stat-value")?.textContent.trim();
          }
        }
        return null;
      }

      // Lógica de Classes
      const classSections = Array.from(
        document.querySelectorAll("section.v3-card")
      );
      const classSection = classSections.find((s) =>
        s.querySelector(".v3-card__title")?.textContent.includes("Classes")
      );

      if (classSection) {
        const classBlocks = classSection.querySelectorAll(
          ".flex.items-center.gap-4"
        );
        let maxMin = -1;
        let totalMin = 0;

        classBlocks.forEach((block) => {
          const name = block.querySelector("span.text-12")?.textContent.trim();
          const timeRaw =
            block.querySelector(".stat-value span")?.textContent.trim() || "";
          const mins = parseTimeInMinutes(timeRaw);
          totalMin += mins;
          if (mins > maxMin) {
            maxMin = mins;
            finalData.bestClass = name;
          }
        });
        finalData.timePlayed = `${Math.floor(totalMin / 60)}h`;
      }

      // Stats Gerais
      const gridStats = document.querySelector(".grid.grid-cols-2.gap-px");
      if (gridStats) {
        finalData.hsPercent = parseNumber(
          getStatFromContainer(gridStats, "HS%")
        );
        finalData.objectivesCaptured = parseNumber(
          getStatFromContainer(gridStats, "Objectives Captured")
        );
        finalData.objectivesDestroyed = parseNumber(
          getStatFromContainer(gridStats, "Objectives Destroyed")
        );
      }

      // Detalhes (Kills, Deaths, etc)
      const detailedGrids = document.querySelectorAll(
        ".v3-card__body.grid.grid-cols-2"
      );
      detailedGrids.forEach((grid) => {
        const k = getStatFromContainer(grid, "Kills");
        if (k) finalData.kills += parseNumber(k);

        const w = getStatFromContainer(grid, "Wins");
        if (w) finalData.wins += parseNumber(w);

        const l = getStatFromContainer(grid, "Losses");
        if (l) finalData.losses += parseNumber(l);

        const a = getStatFromContainer(grid, "Assists");
        if (a) finalData.assists += parseNumber(a);

        const d = getStatFromContainer(grid, "Deaths");
        if (d) finalData.deaths += parseNumber(d);

        const r = getStatFromContainer(grid, "Revives");
        if (r) finalData.revives += parseNumber(r);
      });

      finalData.killDeath =
        finalData.deaths > 0
          ? Number((finalData.kills / finalData.deaths).toFixed(2))
          : finalData.kills;

      return finalData;
    });

    await browser.close();
    return data;
  } catch (error) {
    if (browser) await browser.close();
    request.log.error(error);
    return reply.status(500).send({
      error: "Falha no scraping",
      details: error.message,
    });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3001, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
