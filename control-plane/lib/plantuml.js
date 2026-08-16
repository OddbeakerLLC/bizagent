/**
 * PlantUML preview: render .puml source to SVG (or PNG) for inline display in
 * the web UI. Uses a PlantUML wrapper (plantuml.sh) or `plantuml` on PATH.
 * Installer places a user-local stack under ~/.bizagent/tools/ when packages
 * are unavailable; PLANTUML_SH / GRAPHVIZ_DOT may be set in .bizagent/env.
 *
 * Best-effort: if PlantUML is not installed, renderPlantUml throws a clear
 * error the UI can surface instead of silently failing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();

const CANDIDATE_BINS = [
  process.env.PLANTUML_SH,
  path.join(HOME, '.bizagent', 'tools', 'plantuml.sh'),
  path.join(HOME, '.bizagent', 'tools', 'bin', 'plantuml'),
  path.join(HOME, 'tools', 'plantuml.sh'),
  path.join(HOME, '.local', 'bin', 'plantuml'),
  '/usr/local/bin/plantuml',
  '/usr/bin/plantuml',
].filter(Boolean);

/** Locate the PlantUML wrapper (plantuml.sh) or a `plantuml` on PATH. */
function findPlantUml() {
  for (const bin of CANDIDATE_BINS) {
    try {
      if (bin && fs.existsSync(bin) && fs.statSync(bin).isFile()) return bin;
    } catch (_err) { /* keep looking */ }
  }
  try {
    const which = execFileSync('which', ['plantuml'], { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch (_err) { /* not on PATH */ }
  return null;
}

/**
 * Render PlantUML source to a string.
 * @param {string} source - PlantUML diagram source (may include @startuml/@enduml)
 * @param {'svg'|'png'} [format='svg'] - output format
 * @returns {string} rendered output (SVG markup, or PNG bytes for 'png')
 */
function renderPlantUml(source, format = 'svg') {
  const bin = findPlantUml();
  if (!bin) {
    throw new Error(
      'PlantUML is not installed on this hub (plantuml.sh / plantuml not found). ' +
      'Re-run install.sh (it installs Java + PlantUML + Graphviz) or set PLANTUML_SH.',
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-puml-'));
  const puml = path.join(dir, 'diagram.puml');
  fs.writeFileSync(puml, String(source || ''), 'utf8');
  try {
    // plantuml.sh <file> [svg|png|both] writes diagram.<fmt> next to the .puml.
    // System `plantuml` packages accept -t<svg|png> flags instead.
    const base = path.basename(bin);
    if (base === 'plantuml.sh' || bin.endsWith('/plantuml.sh')) {
      execFileSync('bash', [bin, puml, format], {
        stdio: 'pipe',
        env: process.env,
      });
    } else {
      execFileSync(bin, [`-t${format}`, puml], {
        stdio: 'pipe',
        env: process.env,
      });
    }
    const out = path.join(dir, `diagram.${format}`);
    if (!fs.existsSync(out)) {
      throw new Error('PlantUML produced no output for the given source.');
    }
    return fs.readFileSync(out, format === 'png' ? null : 'utf8');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* best-effort */ }
  }
}

module.exports = { findPlantUml, renderPlantUml };
