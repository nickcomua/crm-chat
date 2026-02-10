import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run stale connection cleanup every 60 seconds
crons.interval(
  "cleanup stale connections",
  { seconds: 60 },
  internal.cleanup.staleConnections,
);

export default crons;
