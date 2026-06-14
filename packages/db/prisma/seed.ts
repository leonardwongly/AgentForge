import { builtinPolicyPacks, parsePolicyYaml } from "@agentforge/policy";

import { createPrismaClient } from "../src/index.js";

const prisma = createPrismaClient(
  process.env.DATABASE_URL ?? "postgresql://agentforge:agentforge@localhost:15432/agentforge"
);

async function main(): Promise<void> {
  for (const pack of builtinPolicyPacks) {
    await prisma.policyPack.upsert({
      where: { id: pack.id },
      update: {
        name: pack.name,
        description: pack.description,
        version: pack.version,
        builtIn: pack.builtIn,
        defaultMode: pack.defaultMode,
        contentYaml: pack.contentYaml
      },
      create: {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        version: pack.version,
        builtIn: pack.builtIn,
        defaultMode: pack.defaultMode,
        contentYaml: pack.contentYaml
      }
    });
  }

  const org = await prisma.organization.upsert({
    where: { slug: "local-dev" },
    update: {},
    create: { name: "Local Development", slug: "local-dev" }
  });

  const fintech = builtinPolicyPacks.find((pack) => pack.id === "fintech");
  if (!fintech) {
    throw new Error("Fintech policy pack missing");
  }
  const parsed = parsePolicyYaml(fintech.contentYaml);
  const existing = await prisma.policyVersion.findFirst({
    where: {
      organizationId: org.id,
      repositoryId: null,
      version: fintech.version
    }
  });
  if (!existing) {
    await prisma.policyVersion.create({
      data: {
        organizationId: org.id,
        policyPackId: fintech.id,
        version: fintech.version,
        mode: parsed.config.agentforge.mode,
        contentYaml: fintech.contentYaml,
        contentHash: parsed.contentHash,
        createdBy: "seed"
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
