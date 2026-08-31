export type LogoMotionFrame = {
  mode: 'gather' | 'hold' | 'release' | 'field'
  progress: number
}

export type LogoCanvasMetrics = {
  width: number
  height: number
  dpr: number
}

type LogoDot = {
  x: number
  y: number
  radius: number
}

type Point3D = {
  x: number
  y: number
  z: number
}

export type LogoParticle = {
  targetX: number
  targetY: number
  source: Point3D
  radius: number
  phase: number
  delay: number
  alpha: number
}

const LOGO_DOTS: LogoDot[] = [
  { x: -0.022972, y: 0.230205, radius: 0.003614 },
  { x: -0.073803, y: 0.222385, radius: 0.003614 },
  { x: -0.022972, y: 0.218475, radius: 0.003614 },
  { x: -0.015152, y: 0.214565, radius: 0.003614 },
  { x: 0.08651, y: 0.210655, radius: 0.003614 },
  { x: 0.08651, y: 0.206745, radius: 0.003614 },
  { x: 0.07869, y: 0.202835, radius: 0.003614 },
  { x: -0.011241, y: 0.198925, radius: 0.003614 },
  { x: -0.015152, y: 0.195015, radius: 0.003614 },
  { x: -0.015152, y: 0.191105, radius: 0.003614 },
  { x: -0.050342, y: 0.187195, radius: 0.003614 },
  { x: 0.07869, y: 0.187195, radius: 0.003614 },
  { x: -0.019062, y: 0.183284, radius: 0.003614 },
  { x: -0.085533, y: 0.179374, radius: 0.003614 },
  { x: -0.007331, y: 0.179374, radius: 0.003614 },
  { x: -0.069892, y: 0.175464, radius: 0.003614 },
  { x: 0.04741, y: 0.175464, radius: 0.003614 },
  { x: -0.069892, y: 0.171554, radius: 0.003614 },
  { x: -0.003421, y: 0.171554, radius: 0.003614 },
  { x: -0.183284, y: 0.167644, radius: 0.003614 },
  { x: -0.038612, y: 0.167644, radius: 0.003614 },
  { x: 0.07478, y: 0.167644, radius: 0.003614 },
  { x: -0.050342, y: 0.163734, radius: 0.003614 },
  { x: 0.06696, y: 0.163734, radius: 0.003614 },
  { x: -0.058162, y: 0.159824, radius: 0.003614 },
  { x: 0.05914, y: 0.159824, radius: 0.003614 },
  { x: -0.171554, y: 0.155914, radius: 0.003614 },
  { x: -0.003421, y: 0.155914, radius: 0.003614 },
  { x: 0.160802, y: 0.155914, radius: 0.003614 },
  { x: -0.159824, y: 0.152004, radius: 0.003614 },
  { x: 0.05523, y: 0.152004, radius: 0.003614 },
  { x: -0.202835, y: 0.148094, radius: 0.003614 },
  { x: -0.155914, y: 0.148094, radius: 0.003614 },
  { x: 0.05914, y: 0.148094, radius: 0.003614 },
  { x: -0.202835, y: 0.144184, radius: 0.003614 },
  { x: -0.155914, y: 0.144184, radius: 0.003614 },
  { x: 0.000489, y: 0.144184, radius: 0.003614 },
  { x: 0.145161, y: 0.144184, radius: 0.003614 },
  { x: -0.163734, y: 0.140274, radius: 0.003614 },
  { x: -0.034702, y: 0.140274, radius: 0.003614 },
  { x: 0.137341, y: 0.140274, radius: 0.003614 },
  { x: -0.152004, y: 0.136364, radius: 0.003614 },
  { x: 0.004399, y: 0.136364, radius: 0.003614 },
  { x: 0.145161, y: 0.136364, radius: 0.003614 },
  { x: -0.089443, y: 0.132454, radius: 0.003614 },
  { x: 0.05132, y: 0.132454, radius: 0.003614 },
  { x: -0.155914, y: 0.128543, radius: 0.003614 },
  { x: -0.034702, y: 0.128543, radius: 0.003614 },
  { x: 0.125611, y: 0.128543, radius: 0.003614 },
  { x: -0.128543, y: 0.124633, radius: 0.003614 },
  { x: 0.04741, y: 0.124633, radius: 0.003614 },
  { x: -0.136364, y: 0.120723, radius: 0.003614 },
  { x: 0.016129, y: 0.120723, radius: 0.003614 },
  { x: 0.137341, y: 0.120723, radius: 0.003614 },
  { x: -0.038612, y: 0.116813, radius: 0.003614 },
  { x: 0.121701, y: 0.116813, radius: 0.003614 },
  { x: -0.089443, y: 0.112903, radius: 0.003614 },
  { x: 0.113881, y: 0.112903, radius: 0.003614 },
  { x: -0.093353, y: 0.108993, radius: 0.003614 },
  { x: 0.05132, y: 0.108993, radius: 0.003614 },
  { x: -0.105083, y: 0.105083, radius: 0.003614 },
  { x: 0.0435, y: 0.105083, radius: 0.003614 },
  { x: -0.108993, y: 0.101173, radius: 0.003614 },
  { x: 0.027859, y: 0.101173, radius: 0.003614 },
  { x: -0.230205, y: 0.097263, radius: 0.003614 },
  { x: -0.034702, y: 0.097263, radius: 0.003614 },
  { x: -0.238025, y: 0.093353, radius: 0.003614 },
  { x: -0.081623, y: 0.093353, radius: 0.003614 },
  { x: 0.05132, y: 0.093353, radius: 0.003614 },
  { x: -0.214565, y: 0.089443, radius: 0.003614 },
  { x: 0.023949, y: 0.089443, radius: 0.003614 },
  { x: -0.230205, y: 0.085533, radius: 0.003614 },
  { x: -0.085533, y: 0.085533, radius: 0.003614 },
  { x: 0.04741, y: 0.085533, radius: 0.003614 },
  { x: -0.206745, y: 0.081623, radius: 0.003614 },
  { x: -0.038612, y: 0.081623, radius: 0.003614 },
  { x: 0.09824, y: 0.081623, radius: 0.003614 },
  { x: -0.093353, y: 0.077713, radius: 0.003614 },
  { x: 0.035679, y: 0.077713, radius: 0.003614 },
  { x: -0.198925, y: 0.073803, radius: 0.003614 },
  { x: -0.046432, y: 0.073803, radius: 0.003614 },
  { x: 0.09042, y: 0.073803, radius: 0.003614 },
  { x: -0.159824, y: 0.069892, radius: 0.003614 },
  { x: 0.039589, y: 0.069892, radius: 0.003614 },
  { x: 0.117791, y: 0.069892, radius: 0.003614 },
  { x: -0.163734, y: 0.065982, radius: 0.003614 },
  { x: -0.042522, y: 0.065982, radius: 0.003614 },
  { x: 0.09042, y: 0.065982, radius: 0.003614 },
  { x: -0.210655, y: 0.062072, radius: 0.003614 },
  { x: -0.163734, y: 0.062072, radius: 0.003614 },
  { x: -0.073803, y: 0.062072, radius: 0.003614 },
  { x: 0.06696, y: 0.062072, radius: 0.003614 },
  { x: 0.113881, y: 0.062072, radius: 0.003614 },
  { x: -0.206745, y: 0.058162, radius: 0.003614 },
  { x: -0.159824, y: 0.058162, radius: 0.003614 },
  { x: -0.112903, y: 0.058162, radius: 0.003614 },
  { x: 0.035679, y: 0.058162, radius: 0.003614 },
  { x: 0.102151, y: 0.058162, radius: 0.003614 },
  { x: 0.176442, y: 0.058162, radius: 0.003614 },
  { x: -0.144184, y: 0.054252, radius: 0.003614 },
  { x: -0.077713, y: 0.054252, radius: 0.003614 },
  { x: 0.039589, y: 0.054252, radius: 0.003614 },
  { x: 0.133431, y: 0.054252, radius: 0.003614 },
  { x: -0.210655, y: 0.050342, radius: 0.003614 },
  { x: -0.089443, y: 0.050342, radius: 0.003614 },
  { x: 0.035679, y: 0.050342, radius: 0.003614 },
  { x: 0.168622, y: 0.050342, radius: 0.003614 },
  { x: -0.105083, y: 0.046432, radius: 0.003614 },
  { x: -0.058162, y: 0.046432, radius: 0.003614 },
  { x: 0.05132, y: 0.046432, radius: 0.003614 },
  { x: 0.219453, y: 0.046432, radius: 0.003614 },
  { x: -0.073803, y: 0.042522, radius: 0.003614 },
  { x: 0.031769, y: 0.042522, radius: 0.003614 },
  { x: 0.203812, y: 0.042522, radius: 0.003614 },
  { x: -0.101173, y: 0.038612, radius: 0.003614 },
  { x: -0.054252, y: 0.038612, radius: 0.003614 },
  { x: 0.0435, y: 0.038612, radius: 0.003614 },
  { x: 0.215543, y: 0.038612, radius: 0.003614 },
  { x: -0.101173, y: 0.034702, radius: 0.003614 },
  { x: -0.054252, y: 0.034702, radius: 0.003614 },
  { x: 0.0435, y: 0.034702, radius: 0.003614 },
  { x: -0.152004, y: 0.030792, radius: 0.003614 },
  { x: -0.105083, y: 0.030792, radius: 0.003614 },
  { x: -0.058162, y: 0.030792, radius: 0.003614 },
  { x: 0.035679, y: 0.030792, radius: 0.003614 },
  { x: 0.203812, y: 0.030792, radius: 0.003614 },
  { x: -0.069892, y: 0.026882, radius: 0.003614 },
  { x: 0.023949, y: 0.026882, radius: 0.003614 },
  { x: 0.192082, y: 0.026882, radius: 0.003614 },
  { x: -0.058162, y: 0.022972, radius: 0.003614 },
  { x: 0.027859, y: 0.022972, radius: 0.003614 },
  { x: 0.160802, y: 0.022972, radius: 0.003614 },
  { x: -0.163734, y: 0.019062, radius: 0.003614 },
  { x: 0.008309, y: 0.019062, radius: 0.003614 },
  { x: 0.05523, y: 0.019062, radius: 0.003614 },
  { x: 0.137341, y: 0.019062, radius: 0.003614 },
  { x: 0.184262, y: 0.019062, radius: 0.003614 },
  { x: -0.038612, y: 0.015152, radius: 0.003614 },
  { x: 0.035679, y: 0.015152, radius: 0.003614 },
  { x: 0.0826, y: 0.015152, radius: 0.003614 },
  { x: 0.129521, y: 0.015152, radius: 0.003614 },
  { x: 0.176442, y: 0.015152, radius: 0.003614 },
  { x: -0.034702, y: 0.011241, radius: 0.003614 },
  { x: 0.035679, y: 0.011241, radius: 0.003614 },
  { x: 0.0826, y: 0.011241, radius: 0.003614 },
  { x: 0.129521, y: 0.011241, radius: 0.003614 },
  { x: -0.191105, y: 0.007331, radius: 0.003614 },
  { x: -0.007331, y: 0.007331, radius: 0.003614 },
  { x: 0.0826, y: 0.007331, radius: 0.003614 },
  { x: 0.129521, y: 0.007331, radius: 0.003614 },
  { x: -0.187195, y: 0.003421, radius: 0.003614 },
  { x: -0.003421, y: 0.003421, radius: 0.003614 },
  { x: -0.195015, y: -0.000489, radius: 0.003614 },
  { x: -0.007331, y: -0.000489, radius: 0.003614 },
  { x: -0.226295, y: -0.004399, radius: 0.003614 },
  { x: -0.026882, y: -0.004399, radius: 0.003614 },
  { x: 0.211632, y: -0.004399, radius: 0.003614 },
  { x: -0.234115, y: -0.008309, radius: 0.003614 },
  { x: -0.019062, y: -0.008309, radius: 0.003614 },
  { x: 0.203812, y: -0.008309, radius: 0.003614 },
  { x: -0.241935, y: -0.012219, radius: 0.003614 },
  { x: -0.015152, y: -0.012219, radius: 0.003614 },
  { x: 0.195992, y: -0.012219, radius: 0.003614 },
  { x: -0.245846, y: -0.016129, radius: 0.003614 },
  { x: 0.152981, y: -0.016129, radius: 0.003614 },
  { x: 0.199902, y: -0.016129, radius: 0.003614 },
  { x: -0.019062, y: -0.020039, radius: 0.003614 },
  { x: 0.164712, y: -0.020039, radius: 0.003614 },
  { x: -0.140274, y: -0.023949, radius: 0.003614 },
  { x: -0.022972, y: -0.023949, radius: 0.003614 },
  { x: 0.156891, y: -0.023949, radius: 0.003614 },
  { x: -0.159824, y: -0.027859, radius: 0.003614 },
  { x: -0.112903, y: -0.027859, radius: 0.003614 },
  { x: -0.050342, y: -0.027859, radius: 0.003614 },
  { x: 0.129521, y: -0.027859, radius: 0.003614 },
  { x: -0.191105, y: -0.031769, radius: 0.003614 },
  { x: -0.144184, y: -0.031769, radius: 0.003614 },
  { x: -0.097263, y: -0.031769, radius: 0.003614 },
  { x: -0.050342, y: -0.031769, radius: 0.003614 },
  { x: 0.125611, y: -0.031769, radius: 0.003614 },
  { x: -0.198925, y: -0.035679, radius: 0.003614 },
  { x: -0.152004, y: -0.035679, radius: 0.003614 },
  { x: -0.105083, y: -0.035679, radius: 0.003614 },
  { x: -0.058162, y: -0.035679, radius: 0.003614 },
  { x: 0.117791, y: -0.035679, radius: 0.003614 },
  { x: -0.210655, y: -0.039589, radius: 0.003614 },
  { x: -0.108993, y: -0.039589, radius: 0.003614 },
  { x: -0.062072, y: -0.039589, radius: 0.003614 },
  { x: 0.023949, y: -0.039589, radius: 0.003614 },
  { x: -0.218475, y: -0.0435, radius: 0.003614 },
  { x: -0.058162, y: -0.0435, radius: 0.003614 },
  { x: 0.031769, y: -0.0435, radius: 0.003614 },
  { x: -0.226295, y: -0.04741, radius: 0.003614 },
  { x: -0.058162, y: -0.04741, radius: 0.003614 },
  { x: 0.031769, y: -0.04741, radius: 0.003614 },
  { x: 0.121701, y: -0.04741, radius: 0.003614 },
  { x: -0.073803, y: -0.05132, radius: 0.003614 },
  { x: 0.020039, y: -0.05132, radius: 0.003614 },
  { x: 0.06696, y: -0.05132, radius: 0.003614 },
  { x: 0.113881, y: -0.05132, radius: 0.003614 },
  { x: -0.073803, y: -0.05523, radius: 0.003614 },
  { x: 0.027859, y: -0.05523, radius: 0.003614 },
  { x: 0.07478, y: -0.05523, radius: 0.003614 },
  { x: -0.238025, y: -0.05914, radius: 0.003614 },
  { x: -0.065982, y: -0.05914, radius: 0.003614 },
  { x: 0.039589, y: -0.05914, radius: 0.003614 },
  { x: 0.08651, y: -0.05914, radius: 0.003614 },
  { x: -0.097263, y: -0.06305, radius: 0.003614 },
  { x: 0.008309, y: -0.06305, radius: 0.003614 },
  { x: 0.05914, y: -0.06305, radius: 0.003614 },
  { x: -0.206745, y: -0.06696, radius: 0.003614 },
  { x: -0.065982, y: -0.06696, radius: 0.003614 },
  { x: 0.04741, y: -0.06696, radius: 0.003614 },
  { x: -0.253666, y: -0.07087, radius: 0.003614 },
  { x: -0.112903, y: -0.07087, radius: 0.003614 },
  { x: -0.058162, y: -0.07087, radius: 0.003614 },
  { x: 0.07087, y: -0.07087, radius: 0.003614 },
  { x: 0.176442, y: -0.07087, radius: 0.003614 },
  { x: -0.163734, y: -0.07478, radius: 0.003614 },
  { x: -0.101173, y: -0.07478, radius: 0.003614 },
  { x: 0.027859, y: -0.07478, radius: 0.003614 },
  { x: 0.09433, y: -0.07478, radius: 0.003614 },
  { x: 0.141251, y: -0.07478, radius: 0.003614 },
  { x: -0.218475, y: -0.07869, radius: 0.003614 },
  { x: -0.140274, y: -0.07869, radius: 0.003614 },
  { x: -0.073803, y: -0.07869, radius: 0.003614 },
  { x: 0.08651, y: -0.07869, radius: 0.003614 },
  { x: 0.133431, y: -0.07869, radius: 0.003614 },
  { x: 0.180352, y: -0.07869, radius: 0.003614 },
  { x: -0.128543, y: -0.0826, radius: 0.003614 },
  { x: 0.000489, y: -0.0826, radius: 0.003614 },
  { x: 0.113881, y: -0.0826, radius: 0.003614 },
  { x: 0.160802, y: -0.0826, radius: 0.003614 },
  { x: -0.132454, y: -0.08651, radius: 0.003614 },
  { x: 0.000489, y: -0.08651, radius: 0.003614 },
  { x: 0.129521, y: -0.08651, radius: 0.003614 },
  { x: -0.120723, y: -0.09042, radius: 0.003614 },
  { x: 0.012219, y: -0.09042, radius: 0.003614 },
  { x: 0.156891, y: -0.09042, radius: 0.003614 },
  { x: -0.069892, y: -0.09433, radius: 0.003614 },
  { x: 0.141251, y: -0.09433, radius: 0.003614 },
  { x: -0.128543, y: -0.09824, radius: 0.003614 },
  { x: 0.008309, y: -0.09824, radius: 0.003614 },
  { x: 0.172532, y: -0.09824, radius: 0.003614 },
  { x: -0.073803, y: -0.102151, radius: 0.003614 },
  { x: 0.05914, y: -0.102151, radius: 0.003614 },
  { x: -0.136364, y: -0.106061, radius: 0.003614 },
  { x: 0.008309, y: -0.106061, radius: 0.003614 },
  { x: 0.192082, y: -0.106061, radius: 0.003614 },
  { x: -0.062072, y: -0.109971, radius: 0.003614 },
  { x: 0.07087, y: -0.109971, radius: 0.003614 },
  { x: -0.089443, y: -0.113881, radius: 0.003614 },
  { x: 0.04741, y: -0.113881, radius: 0.003614 },
  { x: 0.203812, y: -0.113881, radius: 0.003614 },
  { x: -0.054252, y: -0.117791, radius: 0.003614 },
  { x: 0.07478, y: -0.117791, radius: 0.003614 },
  { x: -0.085533, y: -0.121701, radius: 0.003614 },
  { x: 0.05523, y: -0.121701, radius: 0.003614 },
  { x: -0.089443, y: -0.125611, radius: 0.003614 },
  { x: 0.05523, y: -0.125611, radius: 0.003614 },
  { x: -0.148094, y: -0.129521, radius: 0.003614 },
  { x: 0.008309, y: -0.129521, radius: 0.003614 },
  { x: -0.163734, y: -0.133431, radius: 0.003614 },
  { x: -0.003421, y: -0.133431, radius: 0.003614 },
  { x: 0.09433, y: -0.133431, radius: 0.003614 },
  { x: -0.058162, y: -0.137341, radius: 0.003614 },
  { x: 0.08651, y: -0.137341, radius: 0.003614 },
  { x: -0.089443, y: -0.141251, radius: 0.003614 },
  { x: 0.05523, y: -0.141251, radius: 0.003614 },
  { x: -0.163734, y: -0.145161, radius: 0.003614 },
  { x: 0.000489, y: -0.145161, radius: 0.003614 },
  { x: 0.117791, y: -0.145161, radius: 0.003614 },
  { x: -0.054252, y: -0.149071, radius: 0.003614 },
  { x: 0.09824, y: -0.149071, radius: 0.003614 },
  { x: -0.171554, y: -0.152981, radius: 0.003614 },
  { x: 0.000489, y: -0.152981, radius: 0.003614 },
  { x: 0.125611, y: -0.152981, radius: 0.003614 },
  { x: -0.093353, y: -0.156891, radius: 0.003614 },
  { x: 0.0435, y: -0.156891, radius: 0.003614 },
  { x: 0.141251, y: -0.156891, radius: 0.003614 },
  { x: -0.093353, y: -0.160802, radius: 0.003614 },
  { x: 0.04741, y: -0.160802, radius: 0.003614 },
  { x: 0.149071, y: -0.160802, radius: 0.003614 },
  { x: -0.167644, y: -0.164712, radius: 0.003614 },
  { x: 0.008309, y: -0.164712, radius: 0.003614 },
  { x: 0.145161, y: -0.164712, radius: 0.003614 },
  { x: -0.175464, y: -0.168622, radius: 0.003614 },
  { x: -0.026882, y: -0.168622, radius: 0.003614 },
  { x: 0.145161, y: -0.168622, radius: 0.003614 },
  { x: -0.175464, y: -0.172532, radius: 0.003614 },
  { x: 0.000489, y: -0.172532, radius: 0.003614 },
  { x: 0.152981, y: -0.172532, radius: 0.003614 },
  { x: -0.093353, y: -0.176442, radius: 0.003614 },
  { x: 0.020039, y: -0.176442, radius: 0.003614 },
  { x: -0.101173, y: -0.180352, radius: 0.003614 },
  { x: 0.012219, y: -0.180352, radius: 0.003614 },
  { x: -0.108993, y: -0.184262, radius: 0.003614 },
  { x: 0.004399, y: -0.184262, radius: 0.003614 },
  { x: -0.183284, y: -0.188172, radius: 0.003614 },
  { x: -0.019062, y: -0.188172, radius: 0.003614 },
  { x: 0.141251, y: -0.188172, radius: 0.003614 },
  { x: -0.085533, y: -0.192082, radius: 0.003614 },
  { x: 0.031769, y: -0.192082, radius: 0.003614 },
  { x: -0.081623, y: -0.195992, radius: 0.003614 },
  { x: 0.035679, y: -0.195992, radius: 0.003614 },
  { x: -0.077713, y: -0.199902, radius: 0.003614 },
  { x: 0.0435, y: -0.199902, radius: 0.003614 },
  { x: -0.022972, y: -0.203812, radius: 0.003614 },
  { x: -0.120723, y: -0.207722, radius: 0.003614 },
  { x: 0.012219, y: -0.207722, radius: 0.003614 },
  { x: -0.019062, y: -0.211632, radius: 0.003614 },
  { x: -0.022972, y: -0.215543, radius: 0.003614 },
  { x: -0.022972, y: -0.219453, radius: 0.003614 },
  { x: -0.022972, y: -0.223363, radius: 0.003614 },
  { x: -0.019062, y: -0.227273, radius: 0.003614 },
  { x: 0.023949, y: -0.231183, radius: 0.003614 },
  { x: 0.039589, y: -0.235093, radius: 0.003614 },
  { x: -0.022972, y: -0.242913, radius: 0.003614 },
  { x: 0.0435, y: -0.246823, radius: 0.003614 }
]

const PARTICLES_PER_DOT = 24
const GOLDEN_ANGLE = 2.399963

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

const easeInOut = (progress: number): number =>
  progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2

const easeOut = (progress: number): number => 1 - Math.pow(1 - progress, 3)

const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0

  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const rotate3D = (point: Point3D, yaw: number, pitch: number): Point3D => {
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)
  const x = point.x * cosYaw - point.z * sinYaw
  const z = point.x * sinYaw + point.z * cosYaw

  return {
    x,
    y: point.y * cosPitch - z * sinPitch,
    z: point.y * sinPitch + z * cosPitch
  }
}

export const resolveLogoFrame = (
  time: number,
  duration: number,
  prefersReducedMotion: boolean
): LogoMotionFrame => {
  if (prefersReducedMotion) return { mode: 'hold', progress: 1 }

  const safeDuration = duration > 0 ? duration : 4800
  const elapsed = ((time % safeDuration) + safeDuration) % safeDuration

  if (elapsed < safeDuration * 0.42) {
    return { mode: 'gather', progress: easeInOut(elapsed / (safeDuration * 0.42)) }
  }
  if (elapsed < safeDuration * 0.58) return { mode: 'hold', progress: 1 }
  if (elapsed < safeDuration * 0.86) {
    return {
      mode: 'release',
      progress: 1 - easeInOut((elapsed - safeDuration * 0.58) / (safeDuration * 0.28))
    }
  }

  return {
    mode: 'field',
    progress: easeOut((elapsed - safeDuration * 0.86) / (safeDuration * 0.14)) * 0.02
  }
}

export const createLogoParticles = (
  metrics: LogoCanvasMetrics,
  seed = 0x5c1e4ce
): LogoParticle[] => {
  const random = createRandom(seed)
  const randomBetween = (minimum: number, maximum: number): number =>
    minimum + random() * (maximum - minimum)
  const logoSize = Math.min(metrics.width, metrics.height) * 0.42
  const centerX = metrics.width / 2
  const centerY = metrics.height / 2
  const count = LOGO_DOTS.length * PARTICLES_PER_DOT

  return Array.from({ length: count }, (_, index) => {
    const dot = LOGO_DOTS[index % LOGO_DOTS.length]
    const pointAngle = index * GOLDEN_ANGLE + randomBetween(-0.18, 0.18)
    const pointRadius = Math.sqrt(random()) * dot.radius
    const pointX = dot.x + Math.cos(pointAngle) * pointRadius
    const pointY = dot.y + Math.sin(pointAngle) * pointRadius
    const sphereRadius = Math.min(metrics.width, metrics.height) * randomBetween(0.24, 0.36)
    const longitude = index * GOLDEN_ANGLE + randomBetween(-0.18, 0.18)
    const latitude = Math.asin(randomBetween(-0.92, 0.92))
    const sourceRadius = sphereRadius * Math.pow(randomBetween(0.58, 1), 0.38)

    return {
      targetX: centerX + pointX * logoSize,
      targetY: centerY + pointY * logoSize,
      source: {
        x: Math.cos(latitude) * Math.cos(longitude) * sourceRadius,
        y: Math.sin(latitude) * sourceRadius * 0.92,
        z: Math.cos(latitude) * Math.sin(longitude) * sourceRadius
      },
      radius: randomBetween(0.68, 1.28) * metrics.dpr,
      phase: randomBetween(0, Math.PI * 2),
      delay: randomBetween(-0.035, 0.05),
      alpha: randomBetween(0.5, 1)
    }
  })
}

const drawResolvedLogo = (
  context: CanvasRenderingContext2D,
  metrics: LogoCanvasMetrics,
  color: string,
  strength: number,
  time: number
): void => {
  if (strength <= 0) return

  const logoSize = Math.min(metrics.width, metrics.height) * 0.42
  const centerX = metrics.width / 2
  const centerY = metrics.height / 2
  const rotation = time * 0.00028
  const breath = 1 + Math.sin(time * 0.0026) * 0.018
  const cosRotation = Math.cos(rotation)
  const sinRotation = Math.sin(rotation)

  context.fillStyle = color
  context.globalAlpha = 0.94 * strength

  for (const dot of LOGO_DOTS) {
    const dotX = dot.x * logoSize * breath
    const dotY = dot.y * logoSize * breath
    const x = centerX + dotX * cosRotation - dotY * sinRotation
    const y = centerY + dotX * sinRotation + dotY * cosRotation

    context.beginPath()
    context.arc(
      x,
      y,
      Math.max(0.8 * metrics.dpr, dot.radius * logoSize * 0.9 * breath),
      0,
      Math.PI * 2
    )
    context.fill()
  }
}

export const drawPureScienceLogoFrame = (
  context: CanvasRenderingContext2D,
  particles: readonly LogoParticle[],
  metrics: LogoCanvasMetrics,
  color: string,
  frame: LogoMotionFrame,
  time: number
): void => {
  context.clearRect(0, 0, metrics.width, metrics.height)
  context.save()
  context.globalCompositeOperation = 'source-over'
  context.fillStyle = color

  const resolvedStrength = frame.mode === 'hold' ? 1 : clamp((frame.progress - 0.94) / 0.06, 0, 1)
  const particleFade = 1 - resolvedStrength
  const centerX = metrics.width / 2
  const centerY = metrics.height / 2
  const minimumDimension = Math.min(metrics.width, metrics.height)

  for (const particle of particles) {
    const localProgress = clamp(frame.progress + particle.delay, 0, 1)
    const travel = Math.sin(localProgress * Math.PI)
    const settle = Math.pow(localProgress, 3)
    const micro = (1 - settle) * 0.82 * metrics.dpr
    const yaw = time * 0.00034 + particle.phase * 0.03
    const pitch = Math.sin(time * 0.00022 + particle.phase) * 0.16
    const rotated = rotate3D(particle.source, yaw, pitch)
    const perspective = 1 + rotated.z / (minimumDimension * 1.6)
    const depth = clamp((rotated.z / (minimumDimension * 0.36) + 1) / 2, 0, 1)
    const sourceX = centerX + rotated.x * perspective
    const sourceY = centerY + rotated.y * perspective
    const curveX =
      Math.cos(particle.phase + time * 0.0011) * travel * (1 - settle) * 8 * metrics.dpr
    const curveY =
      Math.sin(particle.phase + time * 0.0013) * travel * (1 - settle) * 5.5 * metrics.dpr
    const x =
      sourceX +
      (particle.targetX - sourceX) * localProgress +
      curveX +
      Math.cos(particle.phase + time * 0.0022) * micro
    const y =
      sourceY +
      (particle.targetY - sourceY) * localProgress +
      curveY +
      Math.sin(particle.phase + time * 0.002) * micro
    const depthScale = 0.68 + depth * 0.74
    const radius = particle.radius * depthScale * (0.84 + localProgress * 0.1)
    const opacity = (0.22 + depth * 0.56 + localProgress * 0.16) * particle.alpha * particleFade

    if (opacity < 0.01) continue

    context.globalAlpha = opacity
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }

  drawResolvedLogo(context, metrics, color, resolvedStrength, time)
  context.restore()
}
