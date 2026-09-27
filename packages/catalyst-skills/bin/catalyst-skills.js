#!/usr/bin/env node
// Forwarder (CTC-3479): runs the deprecated `catalyst-skills` launcher of the @catalyst-cloud/cli this
// package pins. It keeps this path because older logins recorded it in customer.json as cliPath.
import "@catalyst-cloud/cli/bin/catalyst-skills.js";
