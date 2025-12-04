/**
 * Roboflow Projects Service
 *
 * Manages Roboflow project listing, creation, and class synchronization.
 * Provides the foundation for multi-project training workflows.
 */
import prisma from '@/lib/db';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_WORKSPACE = process.env.ROBOFLOW_WORKSPACE;
const ROBOFLOW_BASE_URL = 'https://api.roboflow.com';

export interface RoboflowProjectResponse {
  id: string;
  name: string;
  type: string;
  created: string;
  updated: string;
  annotation: string;
  versions: number;
  images: number;
  classes?: Record<string, number>;
}

export interface RoboflowProjectListResponse {
  workspace: string;
  projects: RoboflowProjectResponse[];
}

export interface CreateProjectConfig {
  name: string;
  type: 'object-detection' | 'instance-segmentation';
  annotation?: string;
  license?: string;
}

export interface ProjectWithClasses {
  project: {
    id: string;
    roboflowId: string;
    name: string;
    type: string;
    imageCount: number;
    lastSyncedAt: Date;
  };
  classes: Array<{
    id: string;
    className: string;
    count: number;
    color: string | null;
  }>;
}

/**
 * Service for managing Roboflow projects and syncing classes
 */
class RoboflowProjectsService {
  private apiKey = ROBOFLOW_API_KEY;
  private workspace = ROBOFLOW_WORKSPACE;

  /**
   * Check if the service is configured
   */
  isConfigured(): boolean {
    return Boolean(this.apiKey && this.workspace);
  }

  /**
   * Get configuration error message
   */
  getConfigError(): string | null {
    if (!this.apiKey) return 'ROBOFLOW_API_KEY not configured';
    if (!this.workspace) return 'ROBOFLOW_WORKSPACE not configured';
    return null;
  }

  /**
   * List all projects in the workspace from Roboflow API
   */
  async listProjectsFromRoboflow(): Promise<RoboflowProjectResponse[]> {
    if (!this.isConfigured()) {
      throw new Error(this.getConfigError() || 'Roboflow not configured');
    }

    const url = `${ROBOFLOW_BASE_URL}/${this.workspace}?api_key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list projects: ${response.status} - ${error}`);
    }

    const data: RoboflowProjectListResponse = await response.json();
    return data.projects || [];
  }

  /**
   * Get project details including classes from Roboflow API
   */
  async getProjectFromRoboflow(projectId: string): Promise<RoboflowProjectResponse> {
    if (!this.isConfigured()) {
      throw new Error(this.getConfigError() || 'Roboflow not configured');
    }

    const url = `${ROBOFLOW_BASE_URL}/${this.workspace}/${projectId}?api_key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get project: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /**
   * Create a new project in Roboflow
   */
  async createProjectInRoboflow(config: CreateProjectConfig): Promise<RoboflowProjectResponse> {
    if (!this.isConfigured()) {
      throw new Error(this.getConfigError() || 'Roboflow not configured');
    }

    const url = `${ROBOFLOW_BASE_URL}/${this.workspace}/projects?api_key=${this.apiKey}`;

    // Generate annotation name from project name (lowercase, hyphenated)
    const annotation = config.annotation || config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: config.name,
        type: config.type,
        annotation,
        license: config.license || 'private',
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create project: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /**
   * Sync projects from Roboflow to local database
   * Returns all projects (both from Roboflow and local cache)
   */
  async syncProjects(): Promise<ProjectWithClasses[]> {
    const roboflowProjects = await this.listProjectsFromRoboflow();
    const results: ProjectWithClasses[] = [];

    for (const rfProject of roboflowProjects) {
      // Upsert project in database
      const project = await prisma.roboflowProject.upsert({
        where: { roboflowId: rfProject.id },
        update: {
          name: rfProject.name,
          type: rfProject.type,
          annotation: rfProject.annotation,
          imageCount: rfProject.images || 0,
          lastSyncedAt: new Date(),
        },
        create: {
          roboflowId: rfProject.id,
          workspaceId: this.workspace!,
          name: rfProject.name,
          type: rfProject.type,
          annotation: rfProject.annotation,
          imageCount: rfProject.images || 0,
        },
      });

      // Sync classes if available
      const classes = await this.syncClassesForProject(project.id, rfProject.id);

      results.push({
        project: {
          id: project.id,
          roboflowId: project.roboflowId,
          name: project.name,
          type: project.type,
          imageCount: project.imageCount,
          lastSyncedAt: project.lastSyncedAt,
        },
        classes,
      });
    }

    return results;
  }

  /**
   * Sync classes for a specific project from Roboflow
   */
  async syncClassesForProject(
    localProjectId: string,
    roboflowProjectId: string
  ): Promise<Array<{ id: string; className: string; count: number; color: string | null }>> {
    const rfProject = await this.getProjectFromRoboflow(roboflowProjectId);
    const classesData = rfProject.classes || {};

    // Generate colors for classes
    const colors = [
      '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
      '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280', '#78716c',
    ];

    const results = [];
    let colorIndex = 0;

    for (const [className, count] of Object.entries(classesData)) {
      const upserted = await prisma.roboflowClass.upsert({
        where: {
          projectId_className: {
            projectId: localProjectId,
            className,
          },
        },
        update: {
          count: count as number,
        },
        create: {
          projectId: localProjectId,
          className,
          count: count as number,
          color: colors[colorIndex % colors.length],
        },
      });

      results.push({
        id: upserted.id,
        className: upserted.className,
        count: upserted.count,
        color: upserted.color,
      });

      colorIndex++;
    }

    return results;
  }

  /**
   * Get all cached projects from local database
   */
  async getCachedProjects(): Promise<ProjectWithClasses[]> {
    const projects = await prisma.roboflowProject.findMany({
      include: {
        classes: true,
      },
      orderBy: { name: 'asc' },
    });

    return projects.map((p) => ({
      project: {
        id: p.id,
        roboflowId: p.roboflowId,
        name: p.name,
        type: p.type,
        imageCount: p.imageCount,
        lastSyncedAt: p.lastSyncedAt,
      },
      classes: p.classes.map((c) => ({
        id: c.id,
        className: c.className,
        count: c.count,
        color: c.color,
      })),
    }));
  }

  /**
   * Get a single project with its classes
   */
  async getProjectWithClasses(projectId: string): Promise<ProjectWithClasses | null> {
    const project = await prisma.roboflowProject.findUnique({
      where: { id: projectId },
      include: { classes: true },
    });

    if (!project) return null;

    return {
      project: {
        id: project.id,
        roboflowId: project.roboflowId,
        name: project.name,
        type: project.type,
        imageCount: project.imageCount,
        lastSyncedAt: project.lastSyncedAt,
      },
      classes: project.classes.map((c) => ({
        id: c.id,
        className: c.className,
        count: c.count,
        color: c.color,
      })),
    };
  }

  /**
   * Get classes for a project (from cache, syncs if stale > 15 minutes)
   */
  async getClassesForProject(
    projectId: string,
    forceSync: boolean = false
  ): Promise<Array<{ id: string; className: string; count: number; color: string | null }>> {
    const project = await prisma.roboflowProject.findUnique({
      where: { id: projectId },
      include: { classes: true },
    });

    if (!project) {
      throw new Error('Project not found');
    }

    // Check if cache is stale (> 15 minutes)
    const staleness = Date.now() - project.lastSyncedAt.getTime();
    const isStale = staleness > 15 * 60 * 1000;

    if (forceSync || isStale) {
      return await this.syncClassesForProject(project.id, project.roboflowId);
    }

    return project.classes.map((c) => ({
      id: c.id,
      className: c.className,
      count: c.count,
      color: c.color,
    }));
  }

  /**
   * Add a new class to a project (local only - gets created in Roboflow on first annotation upload)
   */
  async addClassToProject(
    projectId: string,
    className: string
  ): Promise<{ id: string; className: string; count: number; color: string | null }> {
    // Generate a color
    const colors = [
      '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
      '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280', '#78716c',
    ];
    const existingClasses = await prisma.roboflowClass.count({ where: { projectId } });
    const color = colors[existingClasses % colors.length];

    const created = await prisma.roboflowClass.create({
      data: {
        projectId,
        className,
        count: 0,
        color,
      },
    });

    return {
      id: created.id,
      className: created.className,
      count: created.count,
      color: created.color,
    };
  }

  /**
   * Create a new project (in Roboflow and local database)
   */
  async createProject(config: CreateProjectConfig): Promise<ProjectWithClasses> {
    // Create in Roboflow
    const rfProject = await this.createProjectInRoboflow(config);

    // Create in local database
    const project = await prisma.roboflowProject.create({
      data: {
        roboflowId: rfProject.id,
        workspaceId: this.workspace!,
        name: rfProject.name,
        type: rfProject.type,
        annotation: rfProject.annotation,
        imageCount: 0,
      },
    });

    return {
      project: {
        id: project.id,
        roboflowId: project.roboflowId,
        name: project.name,
        type: project.type,
        imageCount: project.imageCount,
        lastSyncedAt: project.lastSyncedAt,
      },
      classes: [],
    };
  }
}

// Export singleton instance
export const roboflowProjectsService = new RoboflowProjectsService();
