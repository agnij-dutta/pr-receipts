// Remove previous build output so a deleted source file can't leave a stale
// module behind in the committed dist/ that the Action runs.
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
