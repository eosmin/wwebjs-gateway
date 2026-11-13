// The WhatsApp Web build as a label of a metric and a word of a log: only the form WhatsApp Web uses
// (2.3000.<number>), anything else is `unknown`, so what the page answers can never grow the series
// or put text in a log.
const BUILD_PATTERN = /^2\.3000\.\d{1,20}$/

export function buildLabel(version: string | undefined): string {
  const value = version?.trim()
  return value !== undefined && BUILD_PATTERN.test(value) ? value : 'unknown'
}
