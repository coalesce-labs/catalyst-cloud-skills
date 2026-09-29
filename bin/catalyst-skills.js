#!/usr/bin/env node
// `catalyst-skills`: the deprecated name of `catalyst` (CTC-3479). It runs the same program and adds
// one line on stderr that names `catalyst` (after the program's output on a pipe, before it on a
// terminal; see launch.js). Kept at this path because older logins recorded it in customer.json as
// cliPath; the next run moves that record onto bin/catalyst.js. CTC-3484 removes it.
import { launch } from "./launch.js";

await launch("catalyst-skills", import.meta.url);
