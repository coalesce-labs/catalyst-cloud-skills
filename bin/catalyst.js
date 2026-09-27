#!/usr/bin/env node
// `catalyst`: the command @catalyst-cloud/cli installs (CTC-3479). The launcher lives in ./launch.js.
import { launch } from "./launch.js";

await launch("catalyst", import.meta.url);
