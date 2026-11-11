import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two sample PDFs used by the bundled sample content and the tests. They are
// never published: `npm run dev` serves them at /documents/, and builds include
// them only when LIBRARY_TEST_FIXTURES=1 (local test builds). The production
// build (GitHub Actions) never sets it.
const SAMPLE_DOCUMENTS = "test/fixtures/documents";

function sampleDocuments() {
  return {
    name: "sample-documents",
    configureServer(server) {
      server.middlewares.use("/documents/", (request, response, next) => {
        const name = decodeURIComponent(String(request.url ?? "").split("?")[0]).replace(/^\/+/, "");
        if (!/^[a-z0-9-]+\.pdf$/.test(name)) return next();
        try {
          const data = readFileSync(`${SAMPLE_DOCUMENTS}/${name}`);
          response.setHeader("Content-Type", "application/pdf");
          response.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      if (process.env.LIBRARY_TEST_FIXTURES !== "1") return;
      for (const name of readdirSync(SAMPLE_DOCUMENTS)) {
        this.emitFile({ type: "asset", fileName: `documents/${name}`, source: readFileSync(`${SAMPLE_DOCUMENTS}/${name}`) });
      }
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [react(), sampleDocuments()],
});
