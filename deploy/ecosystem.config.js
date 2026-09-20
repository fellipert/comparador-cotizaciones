module.exports = {
  apps: [
    {
      name: "comparador-cotizaciones",
      script: "src/server.js",
      cwd: __dirname + "/..",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        DATA_DIR: __dirname + "/../data",
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
    },
  ],
};

