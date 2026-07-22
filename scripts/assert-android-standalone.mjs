if (process.env.VITE_API_BASE_URL?.trim()) {
  console.error("Android builds are standalone; VITE_API_BASE_URL must not be set.");
  process.exit(1);
}
console.log("Android standalone build: no Langtut backend URL configured.");
