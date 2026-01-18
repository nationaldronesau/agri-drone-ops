import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.manualAnnotation.updateMany({
    where: {
      verified: false,
      verifiedAt: null,
    },
    data: {
      verified: true,
      verifiedAt: new Date(),
    },
  });

  console.log(`Updated ${result.count} manual annotations to verified=true`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
