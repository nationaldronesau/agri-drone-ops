/**
 * API Authentication Utilities
 *
 * Provides authentication and authorization helpers for API routes.
 * Includes session validation and project membership checks.
 */
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import prisma from '@/lib/db';

export interface AuthResult {
  authenticated: boolean;
  userId?: string;
  error?: string;
}

export interface ProjectAuthResult extends AuthResult {
  hasAccess: boolean;
  projectId?: string;
  teamId?: string;
}

/**
 * Get the current authenticated user from the session.
 * Returns the user ID if authenticated, null otherwise.
 */
export async function getAuthenticatedUser(): Promise<AuthResult> {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return { authenticated: false, error: 'Authentication required' };
    }

    return { authenticated: true, userId: session.user.id };
  } catch (error) {
    console.error('Auth error:', error);
    return { authenticated: false, error: 'Authentication failed' };
  }
}

/**
 * Check if the authenticated user has access to a specific project.
 * Validates through team membership.
 */
export async function checkProjectAccess(projectId: string): Promise<ProjectAuthResult> {
  const auth = await getAuthenticatedUser();

  if (!auth.authenticated || !auth.userId) {
    return { ...auth, hasAccess: false };
  }

  try {
    // Get the project and its team
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        teamId: true,
        team: {
          select: {
            members: {
              where: { userId: auth.userId },
              select: { id: true, role: true },
            },
          },
        },
      },
    });

    if (!project) {
      return {
        authenticated: true,
        userId: auth.userId,
        hasAccess: false,
        error: 'Project not found',
      };
    }

    // Check if user is a member of the project's team
    const isMember = project.team.members.length > 0;

    if (!isMember) {
      return {
        authenticated: true,
        userId: auth.userId,
        hasAccess: false,
        error: 'Access denied - not a team member',
      };
    }

    return {
      authenticated: true,
      userId: auth.userId,
      hasAccess: true,
      projectId: project.id,
      teamId: project.teamId,
    };
  } catch (error) {
    console.error('Project access check error:', error);
    return {
      authenticated: true,
      userId: auth.userId,
      hasAccess: false,
      error: 'Failed to verify project access',
    };
  }
}

/**
 * Get all team IDs that the authenticated user is a member of.
 * Returns empty array if not authenticated.
 */
export async function getUserTeamIds(): Promise<{ authenticated: boolean; userId?: string; teamIds: string[]; error?: string }> {
  const auth = await getAuthenticatedUser();

  if (!auth.authenticated || !auth.userId) {
    return { authenticated: false, teamIds: [], error: auth.error };
  }

  try {
    const memberships = await prisma.teamMember.findMany({
      where: { userId: auth.userId },
      select: { teamId: true },
    });

    return {
      authenticated: true,
      userId: auth.userId,
      teamIds: memberships.map((m) => m.teamId),
    };
  } catch (error) {
    console.error('Get user teams error:', error);
    return {
      authenticated: true,
      userId: auth.userId,
      teamIds: [],
      error: 'Failed to get user teams',
    };
  }
}

/**
 * Check if the authenticated user has access to an asset through its project.
 */
export async function checkAssetAccess(assetId: string): Promise<ProjectAuthResult> {
  const auth = await getAuthenticatedUser();

  if (!auth.authenticated || !auth.userId) {
    return { ...auth, hasAccess: false };
  }

  try {
    // Get the asset and its project's team
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        projectId: true,
        project: {
          select: {
            id: true,
            teamId: true,
            team: {
              select: {
                members: {
                  where: { userId: auth.userId },
                  select: { id: true, role: true },
                },
              },
            },
          },
        },
      },
    });

    if (!asset) {
      return {
        authenticated: true,
        userId: auth.userId,
        hasAccess: false,
        error: 'Asset not found',
      };
    }

    // Check if user is a member of the asset's project's team
    const isMember = asset.project.team.members.length > 0;

    if (!isMember) {
      return {
        authenticated: true,
        userId: auth.userId,
        hasAccess: false,
        error: 'Access denied - not a team member',
      };
    }

    return {
      authenticated: true,
      userId: auth.userId,
      hasAccess: true,
      projectId: asset.projectId,
      teamId: asset.project.teamId,
    };
  } catch (error) {
    console.error('Asset access check error:', error);
    return {
      authenticated: true,
      userId: auth.userId,
      hasAccess: false,
      error: 'Failed to verify asset access',
    };
  }
}
