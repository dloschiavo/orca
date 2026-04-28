import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://orca:orca@localhost:5464/orca",
  },
  strict: true,
  verbose: true,
} satisfies Config;
