// Page-text assembly tests.
//
// The fixture is REAL data: the runs pdfjs produced for a one-page PDF written by the system's own PDF filter
// (captured with the parser the app uses, coordinates and end-of-line markers included). It is embedded as
// bytes rather than reconstructed because the defect this module fixes is only visible in a real text layer —
// the previous `join('')` turned that page into one run-on string.

import { describe, expect, it } from 'vitest'

import {
  PDF_PAGE_TEXT_PARAGRAPH_GAP_RATIO,
  assemblePdfPageText,
  pdfPageTextParagraphs,
  pdfTextRunsFromItems,
  type PdfTextRun
} from './pdf-page-text'

// One page: 19 lines, 259 runs, three paragraphs (Abstract, Methods, Results).
const REAL_PAGE_RUNS: PdfTextRun[] = JSON.parse(
  String.raw`[{"text":"Abstract","x":16.6,"y":763.284,"width":57.608,"height":12,"hasEol":false},{"text":"","x":16.6,"y":739.284,"width":0,"height":0,"hasEol":true},{"text":"We","x":16.6,"y":739.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":31.001,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"report","x":38.204,"y":739.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":81.41,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"a","x":88.612,"y":739.284,"width":7.2,"height":12,"hasEol":false},{"text":" ","x":95.812,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"reproducible","x":103.014,"y":739.284,"width":86.413,"height":12,"hasEol":false},{"text":" ","x":189.428,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"pipeline","x":196.63,"y":739.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":254.238,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"for","x":261.441,"y":739.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":283.043,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"profiling","x":290.246,"y":739.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":355.055,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":362.258,"y":739.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":383.86,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"main","x":391.062,"y":739.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":419.866,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"protease","x":427.068,"y":739.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":484.677,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"of","x":491.879,"y":739.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":506.28,"y":739.284,"width":0.6,"height":0,"hasEol":false},{"text":"SARS-CoV-2","x":513.483,"y":739.284,"width":72.011,"height":12,"hasEol":false},{"text":"","x":16.6,"y":727.284,"width":0,"height":0,"hasEol":true},{"text":"with","x":16.6,"y":727.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":45.404,"y":727.284,"width":0.6,"height":0,"hasEol":false},{"text":"an","x":52.606,"y":727.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":67.007,"y":727.284,"width":0.6,"height":0,"hasEol":false},{"text":"explicit","x":74.21,"y":727.284,"width":57.608,"height":12,"hasEol":false},{"text":"","x":16.6,"y":715.284,"width":0,"height":0,"hasEol":true},{"text":"solvent","x":16.6,"y":715.284,"width":50.407,"height":12,"hasEol":false},{"text":" ","x":67.007,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"model.","x":74.21,"y":715.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":117.416,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"The","x":124.618,"y":715.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":146.22,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"workflow","x":153.423,"y":715.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":211.031,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"couples","x":218.234,"y":715.284,"width":50.407,"height":12,"hasEol":false},{"text":" ","x":268.641,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"a","x":275.843,"y":715.284,"width":7.2,"height":12,"hasEol":false},{"text":" ","x":283.043,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"geometry-based","x":290.246,"y":715.284,"width":100.816,"height":12,"hasEol":false},{"text":" ","x":391.061,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"pocket","x":398.264,"y":715.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":441.47,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"definition","x":448.672,"y":715.284,"width":72.011,"height":12,"hasEol":false},{"text":" ","x":520.683,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"to","x":527.885,"y":715.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":542.286,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"a","x":549.489,"y":715.284,"width":7.2,"height":12,"hasEol":false},{"text":" ","x":556.689,"y":715.284,"width":0.6,"height":0,"hasEol":false},{"text":"rest","x":563.891,"y":715.284,"width":28.804,"height":12,"hasEol":false},{"text":"","x":16.6,"y":703.284,"width":0,"height":0,"hasEol":true},{"text":"raint","x":16.6,"y":703.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":52.605,"y":703.284,"width":0.6,"height":0,"hasEol":false},{"text":"protocol","x":59.807,"y":703.284,"width":57.608,"height":12,"hasEol":false},{"text":"","x":16.6,"y":691.284,"width":0,"height":0,"hasEol":true},{"text":"that","x":16.6,"y":691.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":45.404,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"keeps","x":52.606,"y":691.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":88.611,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":95.813,"y":691.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":117.416,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"catalytic","x":124.618,"y":691.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":189.428,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"dyad","x":196.63,"y":691.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":225.434,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"within","x":232.636,"y":691.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":275.842,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"0.35","x":283.044,"y":691.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":311.848,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"nm","x":319.05,"y":691.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":333.452,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"of","x":340.654,"y":691.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":355.055,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":362.258,"y":691.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":383.86,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"reference","x":391.062,"y":691.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":455.872,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"crystal","x":463.074,"y":691.284,"width":50.407,"height":12,"hasEol":false},{"text":" ","x":513.482,"y":691.284,"width":0.6,"height":0,"hasEol":false},{"text":"pose.","x":520.684,"y":691.284,"width":36.005,"height":12,"hasEol":false},{"text":"","x":16.6,"y":667.284,"width":0,"height":0,"hasEol":true},{"text":"Methods","x":16.6,"y":667.284,"width":50.407,"height":12,"hasEol":false},{"text":"","x":16.6,"y":643.284,"width":0,"height":0,"hasEol":true},{"text":"Receptor","x":16.6,"y":643.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":74.208,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"preparation","x":81.411,"y":643.284,"width":79.212,"height":12,"hasEol":false},{"text":" ","x":160.623,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"used","x":167.825,"y":643.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":196.629,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"a","x":203.831,"y":643.284,"width":7.2,"height":12,"hasEol":false},{"text":" ","x":211.031,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"single","x":218.234,"y":643.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":261.44,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"deposition","x":268.642,"y":643.284,"width":72.011,"height":12,"hasEol":false},{"text":" ","x":340.653,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"of","x":347.855,"y":643.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":362.256,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":369.459,"y":643.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":391.061,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"complex","x":398.264,"y":643.284,"width":50.407,"height":12,"hasEol":false},{"text":" ","x":448.671,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"at","x":455.873,"y":643.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":470.274,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"1.8","x":477.477,"y":643.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":499.079,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"angstrom","x":506.282,"y":643.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":563.89,"y":643.284,"width":0.6,"height":0,"hasEol":false},{"text":"res","x":571.092,"y":643.284,"width":21.602,"height":12,"hasEol":false},{"text":"","x":16.6,"y":631.284,"width":0,"height":0,"hasEol":true},{"text":"olution.","x":16.6,"y":631.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":74.208,"y":631.284,"width":0.6,"height":0,"hasEol":false},{"text":"Water","x":81.411,"y":631.284,"width":36.005,"height":12,"hasEol":false},{"text":"","x":16.6,"y":619.284,"width":0,"height":0,"hasEol":true},{"text":"molecules","x":16.6,"y":619.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":81.41,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"and","x":88.612,"y":619.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":110.214,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":117.417,"y":619.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":139.019,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"co-crystallised","x":146.222,"y":619.284,"width":108.017,"height":12,"hasEol":false},{"text":" ","x":254.238,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"ligand","x":261.441,"y":619.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":304.647,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"were","x":311.849,"y":619.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":340.653,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"removed,","x":347.855,"y":619.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":405.464,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"hydrogens","x":412.666,"y":619.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":477.476,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"were","x":484.678,"y":619.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":513.482,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"added","x":520.684,"y":619.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":556.689,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"at","x":563.891,"y":619.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":578.292,"y":619.284,"width":0.6,"height":0,"hasEol":false},{"text":"p","x":585.495,"y":619.284,"width":7.2,"height":12,"hasEol":false},{"text":"","x":16.6,"y":607.284,"width":0,"height":0,"hasEol":true},{"text":"H","x":16.6,"y":607.284,"width":7.2,"height":12,"hasEol":false},{"text":" ","x":23.8,"y":607.284,"width":0.6,"height":0,"hasEol":false},{"text":"7.4,","x":31.002,"y":607.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":59.806,"y":607.284,"width":0.6,"height":0,"hasEol":false},{"text":"and","x":67.008,"y":607.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":88.611,"y":607.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":95.813,"y":607.284,"width":21.602,"height":12,"hasEol":false},{"text":"","x":16.6,"y":595.284,"width":0,"height":0,"hasEol":true},{"text":"resulting","x":16.6,"y":595.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":81.41,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"topology","x":88.612,"y":595.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":146.22,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"was","x":153.423,"y":595.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":175.025,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"validated","x":182.228,"y":595.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":247.037,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"against","x":254.24,"y":595.284,"width":50.407,"height":12,"hasEol":false},{"text":" ","x":304.647,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":311.849,"y":595.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":333.452,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"deposited","x":340.654,"y":595.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":405.464,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"coordinates","x":412.666,"y":595.284,"width":79.212,"height":12,"hasEol":false},{"text":" ","x":491.878,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"before","x":499.08,"y":595.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":542.286,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"any","x":549.489,"y":595.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":571.091,"y":595.284,"width":0.6,"height":0,"hasEol":false},{"text":"dy","x":578.294,"y":595.284,"width":14.401,"height":12,"hasEol":false},{"text":"","x":16.6,"y":583.284,"width":0,"height":0,"hasEol":true},{"text":"namics","x":16.6,"y":583.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":59.806,"y":583.284,"width":0.6,"height":0,"hasEol":false},{"text":"run.","x":67.008,"y":583.284,"width":28.804,"height":12,"hasEol":false},{"text":"","x":16.6,"y":559.284,"width":0,"height":0,"hasEol":true},{"text":"Results","x":16.6,"y":559.284,"width":50.407,"height":12,"hasEol":false},{"text":"","x":16.6,"y":535.284,"width":0,"height":0,"hasEol":true},{"text":"Minimisation","x":16.6,"y":535.284,"width":86.413,"height":12,"hasEol":false},{"text":" ","x":103.013,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"converged","x":110.216,"y":535.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":175.025,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"after","x":182.228,"y":535.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":218.232,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"4,200","x":225.435,"y":535.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":261.44,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"steps","x":268.642,"y":535.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":304.647,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"with","x":311.849,"y":535.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":340.653,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"a","x":347.855,"y":535.284,"width":7.2,"height":12,"hasEol":false},{"text":" ","x":355.055,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"potential","x":362.258,"y":535.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":427.067,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"energy","x":434.27,"y":535.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":477.476,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"of","x":484.678,"y":535.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":499.079,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"-6264","x":506.282,"y":535.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":542.286,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"+/-","x":549.489,"y":535.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":571.091,"y":535.284,"width":0.6,"height":0,"hasEol":false},{"text":"40","x":578.294,"y":535.284,"width":14.401,"height":12,"hasEol":false},{"text":"","x":23.801,"y":523.284,"width":0,"height":0,"hasEol":true},{"text":"kcal/mol.","x":23.801,"y":523.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":88.611,"y":523.284,"width":0.6,"height":0,"hasEol":false},{"text":"The","x":95.813,"y":523.284,"width":21.602,"height":12,"hasEol":false},{"text":"","x":16.6,"y":511.284,"width":0,"height":0,"hasEol":true},{"text":"backbone","x":16.6,"y":511.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":74.208,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"root-mean-square","x":81.411,"y":511.284,"width":115.218,"height":12,"hasEol":false},{"text":" ","x":196.629,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"deviation","x":203.831,"y":511.284,"width":64.81,"height":12,"hasEol":false},{"text":" ","x":268.641,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"stayed","x":275.843,"y":511.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":319.049,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"below","x":326.252,"y":511.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":362.256,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"0.12","x":369.459,"y":511.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":398.262,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"nm","x":405.465,"y":511.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":419.866,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"over","x":427.068,"y":511.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":455.872,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":463.074,"y":511.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":484.677,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"20","x":491.879,"y":511.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":506.28,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"ps","x":513.483,"y":511.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":527.884,"y":511.284,"width":0.6,"height":0,"hasEol":false},{"text":"restrain","x":535.086,"y":511.284,"width":57.608,"height":12,"hasEol":false},{"text":"","x":16.6,"y":499.284,"width":0,"height":0,"hasEol":true},{"text":"ed","x":16.6,"y":499.284,"width":14.401,"height":12,"hasEol":false},{"text":" ","x":31.001,"y":499.284,"width":0.6,"height":0,"hasEol":false},{"text":"run,","x":38.204,"y":499.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":67.007,"y":499.284,"width":0.6,"height":0,"hasEol":false},{"text":"and","x":74.21,"y":499.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":95.812,"y":499.284,"width":0.6,"height":0,"hasEol":false},{"text":"the","x":103.014,"y":499.284,"width":21.602,"height":12,"hasEol":false},{"text":"","x":16.6,"y":487.284,"width":0,"height":0,"hasEol":true},{"text":"ligand","x":16.6,"y":487.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":59.806,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"retained","x":67.008,"y":487.284,"width":57.608,"height":12,"hasEol":false},{"text":" ","x":124.617,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"its","x":131.819,"y":487.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":153.422,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"hydrogen-bond","x":160.624,"y":487.284,"width":93.614,"height":12,"hasEol":false},{"text":" ","x":254.238,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"network","x":261.441,"y":487.284,"width":50.407,"height":12,"hasEol":false},{"text":" ","x":311.848,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"with","x":319.05,"y":487.284,"width":28.804,"height":12,"hasEol":false},{"text":" ","x":347.854,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"Cys145","x":355.056,"y":487.284,"width":43.206,"height":12,"hasEol":false},{"text":" ","x":398.262,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"and","x":405.465,"y":487.284,"width":21.602,"height":12,"hasEol":false},{"text":" ","x":427.067,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"His41","x":434.27,"y":487.284,"width":36.005,"height":12,"hasEol":false},{"text":" ","x":470.274,"y":487.284,"width":0.6,"height":0,"hasEol":false},{"text":"throughout.","x":477.477,"y":487.284,"width":79.212,"height":12,"hasEol":false}]`
) as PdfTextRun[]

const paragraphsOf = (runs: PdfTextRun[]): string[] =>
  pdfPageTextParagraphs(assemblePdfPageText(runs))

describe('assemblePdfPageText', () => {
  it('keeps the word separation at line ends instead of gluing the page into one run-on string', () => {
    const text = assemblePdfPageText(REAL_PAGE_RUNS)
    // The defect this replaces: "…SARS-CoV-2with an explicit…" — the last word of a line glued to the next.
    expect(text).toContain('SARS-CoV-2 with an explicit solvent model.')
    expect(text).not.toContain('SARS-CoV-2with')
    expect(text).not.toContain('explicitsolvent')
    expect(text).not.toMatch(/ {2}/)
    expect(text).not.toMatch(/\n\s*\n\s*\n/)
  })

  it('finds the real paragraphs of the page from its own line pitch', () => {
    const paragraphs = paragraphsOf(REAL_PAGE_RUNS)
    // The page's tightest line spacing is 12; every 24 gap (above and below a heading) is a paragraph break.
    expect(paragraphs.length).toBe(6)
    expect(paragraphs[0]).toBe('Abstract')
    expect(paragraphs[1]?.startsWith('We report a reproducible pipeline')).toBe(true)
    expect(paragraphs[1]?.endsWith('within 0.35 nm of the reference crystal pose.')).toBe(true)
    expect(paragraphs[2]).toBe('Methods')
    expect(paragraphs[3]?.startsWith('Receptor preparation used')).toBe(true)
    expect(paragraphs[3]?.endsWith('coordinates before any dy namics run.')).toBe(true)
    expect(paragraphs[4]).toBe('Results')
    expect(paragraphs[5]?.endsWith('with Cys145 and His41 throughout.')).toBe(true)
  })

  it('produces paragraphs a per-paragraph record can hash: one line each, stable across runs', () => {
    const first = paragraphsOf(REAL_PAGE_RUNS)
    expect(paragraphsOf([...REAL_PAGE_RUNS])).toEqual(first)
    for (const paragraph of first) {
      expect(paragraph).not.toMatch(/\n/)
      expect(paragraph.trim()).toBe(paragraph)
      expect(paragraph).not.toBe('')
    }
  })

  it('does not invent letters where the page itself broke a word across lines', () => {
    // This probe PDF wraps mid-word at its margin ("…definition to a rest" / "raint protocol"), so the break is
    // real page content. Nothing here de-hyphenates or guesses: the text is reported as the page has it.
    const text = assemblePdfPageText(REAL_PAGE_RUNS)
    expect(text).toContain('rest raint protocol')
    expect(text).toContain('res olution. Water')
  })

  it('falls back to the baseline when a parser reports no end-of-line markers', () => {
    const line = (text: string, y: number): PdfTextRun => ({
      text,
      x: 10,
      y,
      width: 40,
      height: 12
    })
    const paragraphs = paragraphsOf([
      line('first line', 100),
      line('second line', 88),
      line('third line', 64)
    ])
    expect(paragraphs).toEqual(['first line second line', 'third line'])
  })

  it('joins two CJK lines without inserting a space between the characters', () => {
    const line = (text: string, y: number): PdfTextRun => ({
      text,
      x: 10,
      y,
      width: 40,
      height: 12
    })
    const paragraphs = paragraphsOf([
      line('这是第一行', 100),
      line('这是第二行', 88),
      line('另一段', 40)
    ])
    expect(paragraphs).toEqual(['这是第一行这是第二行', '另一段'])
  })

  it('treats the empty runs pdfjs emits as line markers as breaks, not as text', () => {
    const runs: PdfTextRun[] = [
      { text: 'only', x: 10, y: 100, width: 20, height: 12 },
      { text: '', x: 10, y: 100, width: 0, height: 0, hasEol: true },
      { text: 'line', x: 10, y: 88, width: 20, height: 12 }
    ]
    expect(assemblePdfPageText(runs)).toBe('only line')
  })

  it('keeps the text of a run that carries its own end-of-line marker', () => {
    const runs: PdfTextRun[] = [
      { text: 'first word ', x: 10, y: 100, width: 60, height: 12, hasEol: true },
      { text: 'second word', x: 10, y: 88, width: 60, height: 12 }
    ]
    expect(assemblePdfPageText(runs)).toBe('first word second word')
  })

  it('reports a page with no text runs as empty text, not as a paragraph', () => {
    expect(assemblePdfPageText([])).toBe('')
    expect(assemblePdfPageText([{ text: '   ', x: 0, y: 0, width: 0, height: 12 }])).toBe('')
    expect(pdfPageTextParagraphs('')).toEqual([])
  })

  it('does not invent a paragraph break on a single-line page', () => {
    expect(
      assemblePdfPageText([{ text: 'One line only.', x: 10, y: 100, width: 90, height: 12 }])
    ).toBe('One line only.')
    expect(PDF_PAGE_TEXT_PARAGRAPH_GAP_RATIO).toBe(1.5)
  })

  it('keeps the spacing a line carries, because a text-layer table is read from it', () => {
    // Justified text and aligned columns are whitespace runs in the text layer, and
    // `extractPdfTableCandidatesFromText` clusters columns on gaps of two or more spaces (`minGapSpaces`).
    // Collapsing them while assembling would leave that consumer nothing to see.
    const line = (text: string, y: number): PdfTextRun => ({
      text,
      x: 10,
      y,
      width: 200,
      height: 12,
      hasEol: true
    })
    const text = assemblePdfPageText([line('Site    Value', 100), line('control    12.4', 88)])
    expect(text).toContain('Site    Value')
    expect(text).toContain('control    12.4')
  })

  it('never doubles a space at a line join, even when the line starts with its own', () => {
    const runs: PdfTextRun[] = [
      { text: 'first line', x: 10, y: 100, width: 60, height: 12, hasEol: true },
      { text: ' indented continuation', x: 10, y: 88, width: 120, height: 12 }
    ]
    const text = assemblePdfPageText(runs)
    expect(text).toBe('first line indented continuation')
    expect(text).not.toMatch(/ {2}/)
  })
})

describe('pdfTextRunsFromItems', () => {
  it('reads the runs pdfjs hands over, and answers for the shapes that are not text', () => {
    const runs = pdfTextRunsFromItems([
      { str: 'word', transform: [12, 0, 0, 12, 30, 700], width: 24, height: 12, hasEOL: true },
      { str: ' ', transform: [54, 0, 0, 12, 60, 700], width: 6, height: 0 },
      { type: 'beginMarkedContent', id: 'x' },
      null
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({
      text: 'word',
      x: 30,
      y: 700,
      width: 24,
      height: 12,
      hasEol: true
    })
    // A missing hasEOL is "unknown", not "no break": the entry stays absent so the baseline rule decides.
    expect(runs[1]).toMatchObject({ text: ' ', hasEol: false })
    // A malformed transform is reported as no geometry rather than as a guessed coordinate.
    expect(pdfTextRunsFromItems([{ str: 'x', transform: 'nope' }])[0]).toMatchObject({
      x: 0,
      y: 0
    })
    expect(pdfTextRunsFromItems(['not an item'])).toEqual([])
  })
})
