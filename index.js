// Entry point shim.
//
// The host resolves a plugin package's `exports` targets relative to the
// package root and does not descend into subdirectories to find them. A package
// whose entrypoints live under ./src or ./dist is silently skipped, with no
// warning, which cost a day to find. So every exports target is a file here.
export { default } from "./dist/index.js"
