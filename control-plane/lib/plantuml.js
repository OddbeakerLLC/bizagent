/**
 * PlantUML preview: render .puml source to SVG (or PNG) for inline display in
 * the web UI. Uses the user-local PlantUML wrapper (plantuml.sh) installed by
 * the shell-tools agent — no sudo, Java lives under /home/bizagent/tools/.
 *
 * Best-effort: if PlantUML is not installed, renderPlantUml throws a clear
 * error the UI can surface instead of silently failing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CANDIDATE_BINS = [
  process.env.PLANTUML_SH,
  '/home/bizagent/tools/plantuml.sh',
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
      'PlantUML is not installed on this hub (plantuml.sh not found). ' +
      'Ask the shell-tools agent to install it, or set PLANTUML_SH.',
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-puml-'));
  const puml = path.join(dir, 'diagram.puml');
  fs.writeFileSync(puml, String(source || ''), 'utf8');
  try {
    // plantuml.sh <file> [svg|png|both] writes diagram.<fmt> next to the .puml.
    execFileSync('bash', [bin, puml, format], { stdio: 'pipe' });
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
