import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create default user
  const defaultUser = await prisma.user.upsert({
    where: { email: 'default@agridrone.local' },
    update: {},
    create: {
      id: 'default-user',
      email: 'default@agridrone.local',
      name: 'Default User',
    },
  });

  // Create default team
  const defaultTeam = await prisma.team.upsert({
    where: { id: 'default-team' },
    update: {},
    create: {
      id: 'default-team',
      name: 'Default Team',
      members: {
        create: {
          userId: defaultUser.id,
          role: 'OWNER',
        },
      },
    },
  });

  // Create default project
  const defaultProject = await prisma.project.upsert({
    where: { id: 'default-project' },
    update: {},
    create: {
      id: 'default-project',
      name: 'Default Project',
      description: 'Default project for testing',
      teamId: defaultTeam.id,
    },
  });

  console.log('Seed data created:', {
    user: defaultUser,
    team: defaultTeam,
    project: defaultProject,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });