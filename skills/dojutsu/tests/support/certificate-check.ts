// A stand-in for the push gate's certificate check (gates/push-certificate.ts): exits 0 when the project (the working directory) holds a .certified marker.
import { existsSync } from "node:fs";

process.exit(existsSync(".certified") ? 0 : 1);
