#!/usr/bin/env node
// Live probes for the two connectors a developer machine cannot reach, run on a CI runner and printed into
// the job log. Plain Node (no build step) so it costs seconds, not a package build.
//
//   node scripts/probe-connectors.mjs tcia
//   node scripts/probe-connectors.mjs foldseek      # tries several multipart field names
//
// A probe never fails the job: the reading IS the result, including "the service said no".
const TCIA = 'https://services.cancerimagingarchive.net/nbia-api/services/v1'

const show = (label, value) => console.log(`LIVE ${label} ${typeof value === 'string' ? value : JSON.stringify(value).slice(0, 400)}`)

const getJson = async (url) => {
  const res = await fetch(url)
  const text = await res.text()
  if (!/^[[{]/.test(text.trim())) return { status: res.status, nonJson: text.slice(0, 160) }
  return { status: res.status, body: JSON.parse(text) }
}

const tcia = async () => {
  const collections = await getJson(`${TCIA}/getCollectionValues`)
  show('tcia_collections', { status: collections.status, count: collections.body?.length, first: collections.body?.[0], nonJson: collections.nonJson })

  const name = collections.body?.[0]?.Collection
  if (!name) return
  const patients = await getJson(`${TCIA}/getPatient?Collection=${encodeURIComponent(name)}`)
  show('tcia_patient_studies', { collection: name, status: patients.status, count: patients.body?.length, fields: patients.body?.[0] ? Object.keys(patients.body[0]) : [], nonJson: patients.nonJson })

  const series = await getJson(`${TCIA}/getSeries?Collection=${encodeURIComponent(name)}`)
  show('tcia_series_search', { collection: name, status: series.status, count: series.body?.length, fields: series.body?.[0] ? Object.keys(series.body[0]) : [], nonJson: series.nonJson })
}

const foldseek = async () => {
  // FoldSeek takes the coordinates as an uploaded file. The service answers a JSON ticket, or a Go
  // validation sentence ("Key: 'JobRequest.Job.Database' Error:Field validation for 'Database' failed…")
  // when the form field it expects is missing — which is exactly what this experiment is about.
  const pdbRes = await fetch('https://files.rcsb.org/download/1CBS.pdb')
  const pdb = await pdbRes.text()
  console.log(`LIVE rcsb_coordinates status=${pdbRes.status} bytes=${pdb.length}`)

  const field = process.env.FOLDSEEK_FIELD || 'database'
  const form = new FormData()
  form.append('q', new Blob([pdb], { type: 'chemical/x-pdb' }), '1CBS.pdb')
  form.append(field, 'afdb50')
  form.append('mode', '3diaa')

  const res = await fetch('https://search.foldseek.com/api/ticket', { method: 'POST', body: form })
  const text = await res.text()
  console.log(`LIVE foldseek_ticket field=${field} status=${res.status} body=${text.slice(0, 300)}`)

  let ticket
  try {
    ticket = JSON.parse(text)
  } catch {
    return
  }
  if (!ticket?.id) return

  const candidates = [
    `https://search.foldseek.com/api/result/${ticket.id}`,
    `https://search.foldseek.com/api/result/${ticket.id}?format=json`,
    `https://search.foldseek.com/api/result/${ticket.id}.json`,
    `https://search.foldseek.com/api/ticket/${ticket.id}`,
    `https://search.foldseek.com/api/result/${ticket.id}/0`
  ]
  for (const url of candidates) {
    const probeRes = await fetch(url)
    const probeText = await probeRes.text()
    console.log(`LIVE foldseek_result_probe ${url.replace(ticket.id, '<id>')} status=${probeRes.status} body=${probeText.slice(0, 120)}`)
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const statusRes = await fetch(`https://search.foldseek.com/api/ticket/${ticket.id}`)
    const statusText = await statusRes.text()
    let parsed
    try {
      parsed = JSON.parse(statusText)
    } catch {
      console.log(`LIVE foldseek_result nonJson=${statusText.slice(0, 160)}`)
      return
    }
    if (parsed.status === 'COMPLETE' || parsed.status === 'ERROR') {
      const body = await fetch(`https://search.foldseek.com/api/result/${ticket.id}/0`).then((r) => r.json())
      console.log(`LIVE foldseek_body keys=${Object.keys(body).join(',')} head=${JSON.stringify(body).slice(0, 700)}`)
      const alignments = (body.queries ?? []).flatMap((q) => q.alignments ?? [])
      console.log(
        `LIVE foldseek_result status=${parsed.status} hits=${alignments.length} first=${JSON.stringify(alignments[0] ?? null).slice(0, 240)}`
      )
      return
    }
  }
  console.log('LIVE foldseek_result status=still-running')
}

const which = process.argv[2] ?? 'tcia'
if (which === 'tcia') await tcia()
else if (which === 'foldseek') await foldseek()
else {
  await tcia()
  await foldseek()
}
