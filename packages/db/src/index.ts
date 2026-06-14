import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export { Prisma, PrismaClient } from "./generated/prisma/client.js";

/**
 * Creates a Prisma 7 client backed by the node-postgres driver adapter.
 *
 * Prisma ORM v7 removed the Rust query engine and the `datasourceUrl`
 * constructor option; a driver adapter is now required for all databases.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
