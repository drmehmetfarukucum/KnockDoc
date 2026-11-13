import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Store } from "../src/store.mjs";

export const MONDAY_0900_ISTANBUL = Date.parse("2026-10-05T06:00:00Z");
export const DAY = 24 * 60 * 60 * 1000;

/** A real local D1 binding, isolated for each acceptance test. */
export async function createD1Fixture(now = MONDAY_0900_ISTANBUL) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('test'); } };",
    d1Databases: { DB: "test" },
  }));
  try {
    const db = await mf.getD1Database("DB");
    const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
    // D1 exec accepts multiple queries separated by newlines. Keep each whole
    // schema statement on a single line for the D1 exec wire format.
    const statements = schema.replace(/^\s*--.*$/gm, "").split(";").map(sql => sql.trim()).filter(Boolean);
    await db.exec(statements.map(sql => sql.replaceAll("\n", " ")).join("\n"));
    const clock = { value: now };
    const store = new Store(db, () => clock.value);
    return {
      mf, db, store, clock,
      async createWorker() {
        const credentials = await store.createSession();
        const session = await store.session(credentials.token);
        if (!session) throw new Error("Fresh D1 session was not found.");
        return { ...credentials, session };
      },
      dispose: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
