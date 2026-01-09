module.exports = {
  apps: [
    {
      name: "web",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 8080,
      },
    },
    {
      name: "worker",
      script: "npm",
      args: "run worker",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "inference-worker",
      script: "npm",
      args: "run worker:inference",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
