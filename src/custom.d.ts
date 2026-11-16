declare module '*.svg' {
  const content: string
  export default content
}

declare module '*.png' {
  export default content
}

declare module 'leaflet/dist/leaflet-src.esm.js' {
  export * from 'leaflet'
}
