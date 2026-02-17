import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
	"cleanup stale dispatched tasks",
	{ minutes: 5 },
	internal.workerTasks.cleanup,
);

export default crons;
