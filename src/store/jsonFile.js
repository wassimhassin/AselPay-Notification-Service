const fs = require("fs/promises");
const path = require("path");

// Reads a JSON file; returns `fallback` if it doesn't exist.
const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

// Writes through a temp file + rename, so a crash mid-write never leaves a
// truncated file behind.
const writeJsonAtomic = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
};

const removeFile = async (file) => {
  await fs.rm(file, { force: true });
};

module.exports = { readJson, writeJsonAtomic, removeFile };
