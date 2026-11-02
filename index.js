"use strict";

/**
 * Eatfuscator — dsc.gg/eatfuscator
 *
 * Public entry point. Everything lives under src/, grouped by build phase:
 *
 *   src/Parser/      source front end (Luau surface syntax)
 *   src/Steps/       source -> source passes (Minify, Flatten, Luau, Shape)
 *   src/Vm/          register-bytecode back end (Compiler, Image, Template)
 *   src/Envelope/    anti-tamper wrapper + runtime template
 *   src/Core/        the pipeline that chains the steps together
 */

module.exports = require("./src/Core/obfuscate");
