// Entry point shim. See ./index.js for why this file exists.
export { GoalRpc, isGoalAction, isGoalOrigin, pauseReason, GOAL_STATUS_VALUES } from "./src/rpc.ts"
export type { GoalAction, GoalOrigin } from "./src/rpc.ts"
