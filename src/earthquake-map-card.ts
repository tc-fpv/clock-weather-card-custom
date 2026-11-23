import { LitElement, html, css, type TemplateResult, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { type HomeAssistant } from 'custom-card-helpers'
import * as L from 'leaflet/dist/leaflet-src.esm.js'
import leafletCss from './leaflet-css'

export interface EarthquakeMapCardConfig {
  type: string
  entity: string
  home_entity?: string
  height?: number
  title?: string
  latitude?: number
  longitude?: number
  zoom?: number
  radius_entity?: string
  show_radius?: boolean
  time_range?: TimeRange
  show_radar?: boolean
  warnings_entity?: string
  show_warnings?: boolean
  show_forecast?: boolean
}

type TimeRange = '24h' | '7d' | '30d' | 'all'

const RANGES: Array<{ id: TimeRange, label: string, ms: number }> = [
  { id: '24h', label: '24h', ms: 24 * 3600000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 3600000 },
  { id: '30d', label: '30d', ms: 30 * 24 * 3600000 },
  { id: 'all', label: 'All', ms: Infinity }
]

const FORECAST_API = 'https://api.open-meteo.com/v1/forecast'
const FORECAST_HOURS = 48
const FORECAST_COLS = 8
const FORECAST_ROWS = 6

type ForecastMetric = 'temp' | 'rain'

interface ForecastGrid { cols: number, rows: number, bounds: L.LatLngBounds, times: string[], temp: number[][], pop: number[][] }

const TEMP_STOPS: Array<[number, [number, number, number]]> = [
  [-10, [110, 70, 210]], [-2, [60, 120, 235]], [5, [70, 190, 235]], [10, [90, 205, 130]],
  [15, [235, 225, 80]], [20, [250, 170, 60]], [25, [240, 100, 50]], [32, [205, 40, 45]]
]
const TEMP_GRADIENT = 'linear-gradient(to right,rgb(110,70,210),rgb(60,120,235),rgb(70,190,235),rgb(90,205,130),rgb(235,225,80),rgb(250,170,60),rgb(240,100,50),rgb(205,40,45))'
const RAIN_GRADIENT = 'linear-gradient(to right,rgba(40,110,255,0),rgba(40,110,255,1))'

function tempColor (v: number): [number, number, number] {
  const first = TEMP_STOPS[0]
  const last = TEMP_STOPS[TEMP_STOPS.length - 1]
  if (v <= first[0]) return first[1]
  if (v >= last[0]) return last[1]
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [v1, c1] = TEMP_STOPS[i]
    const [v0, c0] = TEMP_STOPS[i - 1]
    if (v <= v1) {
      const t = (v - v0) / (v1 - v0)
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t]
    }
  }
  return last[1]
}

function weatherEmoji (code: number): string {
  if (code === 0) return '\u2600\uFE0F'
  if (code <= 2) return '\u{1F324}\uFE0F'
  if (code === 3) return '\u2601\uFE0F'
  if (code <= 48) return '\u{1F32B}\uFE0F'
  if (code <= 57) return '\u{1F326}\uFE0F'
  if (code <= 67) return '\u{1F327}\uFE0F'
  if (code <= 77) return '\u{1F328}\uFE0F'
  if (code <= 82) return '\u{1F327}\uFE0F'
  if (code <= 86) return '\u{1F328}\uFE0F'
  return '\u26C8\uFE0F'
}

const RADAR_API = 'https://api.rainviewer.com/public/weather-maps.json'

interface Quake {
  id: string
  place: string
  magnitude: number
  depth: string
  lat: number
  lon: number
  time: number
  link: string
  distanceKm: number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards = (window as any).customCards || [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards.push({
  type: 'earthquake-map-card',
  name: 'Earthquake Map Card',
  description: 'Satellite map and list of every earthquake in a BGS (feedparser) earthquake feed sensor.'
})

const SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
const ATTRIBUTION = 'Tiles &copy; Esri, Maxar, Earthstar Geographics. Earthquakes: British Geological Survey (OGL)'

function magnitudeColor (m: number): string {
  if (m >= 3) return '#FF0000'
  if (m >= 2) return '#FF5722'
  if (m >= 1) return '#FFA500'
  return '#FFD700'
}

const WARNING_COLORS: Record<string, string> = { yellow: '#FFD500', amber: '#FF9500', orange: '#FF9500', red: '#E8222B' }
const SEVERITY_COLORS: Record<string, string> = { minor: '#FFD500', moderate: '#FFD500', severe: '#FF9500', extreme: '#E8222B' }

function warningColor (title: string, severity: string): string {
  if (/flood/i.test(title)) return '#29B6F6'
  const word = /^(yellow|amber|orange|red)/i.exec(title.trim())?.[1]?.toLowerCase()
  return (word ? WARNING_COLORS[word] : SEVERITY_COLORS[severity.toLowerCase()]) ?? '#FFD500'
}

// "lat,lon lat,lon ..." (CAP polygon) to Leaflet coordinates
function parsePolygon (text: string): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  for (const pair of text.trim().split(/\s+/)) {
    const [la, lo] = pair.split(',').map(Number)
    if (Number.isFinite(la) && Number.isFinite(lo)) pts.push([la, lo])
  }
  return pts
}

function toTitleCase (s: string): string {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

function haversineKm (lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

function formatAge (ms: number): string {
  const hours = Math.floor(ms / 3600000)
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60000))}m ago`
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

@customElement('earthquake-map-card')
export class EarthquakeMapCard extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant
  @state() private config?: EarthquakeMapCardConfig
  @state() private selectedId: string | null = null
  @state() private range: TimeRange = 'all'

  private map?: L.Map
  private markerLayer?: L.LayerGroup
  private markers = new Map<string, L.CircleMarker>()
  private resizeObserver?: ResizeObserver
  private lastEntries?: unknown
  private radiusLayer?: L.Circle
  private radarLayer?: L.TileLayer
  private radarTimer?: number
  private warningLayer?: L.LayerGroup
  private warningsOn = false
  private forecastOverlay?: L.ImageOverlay
  private forecastOn = false
  private forecastHour = 0
  private forecastMetric: ForecastMetric = 'temp'
  private forecastGrid?: ForecastGrid
  private forecastTimer?: number
  private forecastDebounce?: number
  private forecastSeq = 0
  private forecastLabel?: HTMLElement
  private forecastLegend?: HTMLElement
  private forecastPopup?: L.Popup
  private lastWarnings?: unknown

  static styles = [
    leafletCss,
    css`
      ha-card {
        overflow: hidden;
        container-type: inline-size;
      }
      .layout {
        display: grid;
        grid-template-columns: 2fr 1fr;
        height: var(--eq-height, max(420px, calc(100vh - 160px)));
      }
      @container (max-width: 700px) {
        .layout {
          grid-template-columns: 1fr;
          grid-template-rows: 1fr 1fr;
        }
      }
      .map {
        height: 100%;
        min-height: 200px;
        background: #1c1c1c;
      }
      .list {
        overflow-y: auto;
        height: 100%;
      }
      .filters {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        background: var(--card-background-color, #fff);
        border-bottom: 1px solid var(--divider-color);
      }
      .filters button {
        flex: 1;
        padding: 4px 0;
        cursor: pointer;
        border: 1px solid var(--divider-color);
        border-radius: 14px;
        background: transparent;
        color: var(--primary-text-color);
        font: inherit;
      }
      .filters button.active {
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
        border-color: var(--primary-color);
      }
      .row {
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        cursor: pointer;
        border-bottom: 1px solid var(--divider-color);
      }
      .row.selected {
        background: var(--secondary-background-color);
      }
      .badge {
        flex: none;
        min-width: 2.6em;
        text-align: center;
        font-weight: bold;
        border-radius: 6px;
        padding: 4px 6px;
        color: #000;
      }
      .place {
        font-weight: 500;
      }
      .meta {
        font-size: 0.85em;
        color: var(--secondary-text-color);
      }
      .empty {
        padding: 16px;
        color: var(--secondary-text-color);
      }
      .leaflet-container {
        font-family: inherit;
      }

    `
  ]

  public setConfig (config: EarthquakeMapCardConfig): void {
    if (!config?.entity) {
      throw new Error('You need to define an entity (the BGS earthquake feed sensor)')
    }
    this.config = config
    this.range = config.time_range ?? 'all'
  }

  public getCardSize (): number {
    return Math.ceil((this.config?.height ?? 500) / 50)
  }

  public static getStubConfig (): Record<string, unknown> {
    return { entity: 'sensor.bgs_uk_earthquakes' }
  }

  private getHome (): [number, number] | null {
    const zone = this.hass?.states[this.config?.home_entity ?? 'zone.home']
    const lat = Number(zone?.attributes?.latitude ?? this.hass?.config?.latitude)
    const lon = Number(zone?.attributes?.longitude ?? this.hass?.config?.longitude)
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null
  }

  private getQuakes (): Quake[] {
    const entityId = this.config?.entity
    if (!entityId || !this.hass) return []
    const entries = this.hass.states[entityId]?.attributes?.entries as Array<Record<string, string>> | undefined
    if (!Array.isArray(entries)) return []

    const home = this.getHome()
    const haveHome = home !== null
    const [homeLat, homeLon] = home ?? [0, 0]
    const cutoff = Date.now() - (RANGES.find(r => r.id === this.range)?.ms ?? Infinity)

    const quakes: Quake[] = []
    for (const e of entries) {
      const lat = parseFloat(e.geo_lat)
      const lon = parseFloat(e.geo_long)
      const summary = e.summary ?? ''
      const mag = parseFloat(summary.split('Magnitude:')[1] ?? '')
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(mag)) continue
      const place = /Location:\s*([^;]+);/.exec(summary)?.[1]?.trim() ?? ''
      const depth = /Depth:\s*([^;]+);/.exec(summary)?.[1]?.trim() ?? ''
      // BGS publishes times without a zone; they are UTC. Prefer the full date in the summary:
      // the feed's "published" field can lack the year ("Wed, Nov 18 04:53 PM"), which parses as 2001.
      const origin = /Origin date\/time:\s*([^;]+);/.exec(summary)?.[1]?.trim() ?? e.published ?? ''
      const time = Date.parse(`${origin} GMT`)
      if (Number.isFinite(time) && time < cutoff) continue
      quakes.push({
        id: e.link ?? `${lat},${lon},${origin}`,
        place: toTitleCase(place.replace(/\s*,\s*/g, ', ')),
        magnitude: mag,
        depth,
        lat,
        lon,
        time,
        link: e.link ?? '',
        distanceKm: haveHome ? haversineKm(homeLat, homeLon, lat, lon) : null
      })
    }
    return quakes.sort((a, b) => (b.time || 0) - (a.time || 0))
  }

  protected render (): TemplateResult {
    if (!this.config) return html``
    const quakes = this.getQuakes()
    const heightStyle = this.config.height !== undefined ? `--eq-height: ${this.config.height}px` : ''
    return html`
      <ha-card .header=${this.config.title ?? ''}>
        <div class="layout" style=${heightStyle}>
          <div class="map"></div>
          <div class="list">
            <div class="filters">
              ${RANGES.map(r => html`<button class=${r.id === this.range ? 'active' : ''} @click=${() => { this.range = r.id }}>${r.label}</button>`)}
            </div>
            ${quakes.length === 0
              ? html`<div class="empty">No earthquakes in this period.</div>`
              : quakes.map(q => html`
                <div class="row ${q.id === this.selectedId ? 'selected' : ''}" data-id=${q.id} @click=${() => { this.select(q.id, true) }}>
                  <div class="badge" style="background: ${magnitudeColor(q.magnitude)}">${q.magnitude.toFixed(1)}</div>
                  <div>
                    <div class="place">${q.place || 'Unknown location'}</div>
                    <div class="meta">
                      ${Number.isFinite(q.time) ? formatAge(Date.now() - q.time) : ''}${q.distanceKm !== null ? ` · ${Math.round(q.distanceKm)} km from home` : ''}${q.depth ? ` · depth ${q.depth}` : ''}
                    </div>
                  </div>
                </div>`)}
          </div>
        </div>
      </ha-card>`
  }

  protected updated (changedProps: PropertyValues): void {
    super.updated(changedProps)
    if (!this.config) return
    if (!this.map) {
      this.initMap()
    }
    const entries = this.hass?.states[this.config.entity]?.attributes?.entries
    if (this.map && (entries !== this.lastEntries || changedProps.has('config') || changedProps.has('range'))) {
      this.lastEntries = entries
      this.drawMarkers()
    }
    const warnings = this.config.warnings_entity ? this.hass?.states[this.config.warnings_entity]?.attributes?.entries : undefined
    if (this.map && warnings !== this.lastWarnings) {
      this.lastWarnings = warnings
      this.drawWarnings()
    }
    this.updateRadius()
  }

  public disconnectedCallback (): void {
    super.disconnectedCallback()
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    window.clearInterval(this.radarTimer)
    this.radarTimer = undefined
    this.radarLayer = undefined
    this.warningLayer = undefined
    this.lastWarnings = undefined
    window.clearInterval(this.forecastTimer)
    window.clearTimeout(this.forecastDebounce)
    this.forecastOverlay = undefined
    this.forecastGrid = undefined
    this.forecastPopup = undefined
    this.radiusLayer = undefined
    this.map?.remove()
    this.map = undefined
    this.markerLayer = undefined
    this.markers.clear()
    this.lastEntries = undefined
  }

  private initMap (): void {
    const container = this.renderRoot.querySelector<HTMLElement>('.map')
    if (!container) return
    const home = this.getHome()
    const lat = this.config?.latitude ?? home?.[0] ?? 54.5
    const lon = this.config?.longitude ?? home?.[1] ?? -3
    this.map = L.map(container, { zoomSnap: 0.5, worldCopyJump: true }).setView([lat, lon], this.config?.zoom ?? 8)
    L.tileLayer(SATELLITE_URL, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(this.map)
    L.tileLayer(LABELS_URL, { maxZoom: 18 }).addTo(this.map)
    this.markerLayer = L.layerGroup().addTo(this.map)
    this.resizeObserver = new ResizeObserver(() => { this.map?.invalidateSize() })
    this.resizeObserver.observe(container)
    this.initRadar()
  }

  private async fetchRadarUrl (): Promise<string | null> {
    try {
      const res = await fetch(RADAR_API)
      const data = await res.json() as { host: string, radar: { past: Array<{ path: string }> } }
      const latest = data.radar.past[data.radar.past.length - 1]
      return latest ? `${data.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png` : null
    } catch (err) {
      console.warn('earthquake-map-card: could not load rain radar', err)
      return null
    }
  }

  private initRadar (): void {
    const map = this.map
    if (!map) return
    const Control = L.Control.extend({
      onAdd: () => {
        const box = L.DomUtil.create('div', 'leaflet-bar')
        box.style.cssText = 'background:#fff;color:#333;padding:4px 8px;font:12px/1.4 sans-serif'
        L.DomEvent.disableClickPropagation(box)
        if (this.config?.warnings_entity) {
          const wl = document.createElement('label')
          wl.style.cursor = 'pointer'
          const wi = document.createElement('input')
          wi.type = 'checkbox'
          wi.style.verticalAlign = 'middle'
          wi.checked = this.config.show_warnings !== false
          this.warningsOn = wi.checked
          wl.append(wi, ' Weather warnings')
          wi.addEventListener('change', () => { this.warningsOn = wi.checked; this.drawWarnings() })
          const wrow = document.createElement('div')
          wrow.append(wl)
          box.append(wrow)
        }
        const label = document.createElement('label')
        label.style.cursor = 'pointer'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.style.verticalAlign = 'middle'
        label.append(input, ' Rain radar')
        const status = document.createElement('div')
        status.style.cssText = 'color:#b00020;display:none'
        box.append(label, status)
        const apply = (): void => {
          void this.setRadar(input.checked).then(ok => {
            status.style.display = ok ? 'none' : 'block'
            status.textContent = ok ? '' : 'Rain radar unavailable'
            if (!ok) input.checked = false
          })
        }
        input.addEventListener('change', apply)
        if (this.config?.show_radar === true) {
          input.checked = true
          apply()
        }
        const frow = document.createElement('div')
        const flabel = document.createElement('label')
        flabel.style.cursor = 'pointer'
        const finput = document.createElement('input')
        finput.type = 'checkbox'
        finput.style.verticalAlign = 'middle'
        flabel.append(finput, ' Forecast')
        const fstatus = document.createElement('div')
        fstatus.style.cssText = 'color:#b00020;display:none'
        const fdetails = document.createElement('div')
        fdetails.style.display = 'none'
        const select = document.createElement('select')
        select.style.cssText = 'width:100%;margin:2px 0'
        for (const [value, text] of [['temp', 'Temperature'], ['rain', 'Chance of rain']]) {
          const o = document.createElement('option')
          o.value = value
          o.textContent = text
          select.append(o)
        }
        const slider = document.createElement('input')
        slider.type = 'range'
        slider.min = '0'
        slider.max = String(FORECAST_HOURS - 1)
        slider.step = '1'
        slider.value = '0'
        slider.style.cssText = 'width:150px'
        const flab = document.createElement('div')
        flab.style.textAlign = 'center'
        const legend = document.createElement('div')
        legend.style.cssText = 'height:8px;border-radius:4px;margin:2px 0'
        const scale = document.createElement('div')
        scale.style.cssText = 'display:flex;justify-content:space-between;font-size:10px;color:#666'
        const lo = document.createElement('span')
        const hi = document.createElement('span')
        scale.append(lo, hi)
        const hint = document.createElement('div')
        hint.style.cssText = 'font-size:10px;color:#666;text-align:center'
        hint.textContent = 'Click the map for hourly detail'
        fdetails.append(select, slider, flab, legend, scale, hint)
        this.forecastLabel = flab
        const paintLegend = (): void => {
          const temp = this.forecastMetric === 'temp'
          legend.style.background = temp ? TEMP_GRADIENT : RAIN_GRADIENT
          lo.textContent = temp ? '-10\u00B0' : '0%'
          hi.textContent = temp ? '32\u00B0' : '100%'
        }
        paintLegend()
        frow.append(flabel, fstatus, fdetails)
        box.append(frow)
        const applyForecast = (): void => {
          this.forecastOn = finput.checked
          fdetails.style.display = finput.checked ? 'block' : 'none'
          void this.setForecast(finput.checked).then(ok => {
            fstatus.style.display = ok ? 'none' : 'block'
            fstatus.textContent = ok ? '' : 'Forecast unavailable'
            if (!ok) { finput.checked = false; this.forecastOn = false; fdetails.style.display = 'none' }
          })
        }
        finput.addEventListener('change', applyForecast)
        select.addEventListener('change', () => { this.forecastMetric = select.value as ForecastMetric; paintLegend(); this.drawForecast() })
        slider.addEventListener('input', () => { this.forecastHour = Number(slider.value); this.drawForecast() })
        if (this.config?.show_forecast === true) {
          finput.checked = true
          applyForecast()
        }
        return box
      }
    })
    new Control({ position: 'topright' }).addTo(map)
  }

  private async setRadar (on: boolean): Promise<boolean> {
    const map = this.map
    if (!map) return false
    window.clearInterval(this.radarTimer)
    this.radarTimer = undefined
    if (!on) {
      this.radarLayer?.remove()
      return true
    }
    const url = await this.fetchRadarUrl()
    if (!url || map !== this.map) return false
    if (this.radarLayer) {
      this.radarLayer.setUrl(url)
    } else {
      this.radarLayer = L.tileLayer(url, { opacity: 0.6, maxZoom: 18, maxNativeZoom: 7, attribution: 'Radar: RainViewer' })
    }
    this.radarLayer.addTo(map)
    // Radar frames update about every 10 minutes
    this.radarTimer = window.setInterval(() => {
      void this.fetchRadarUrl().then(u => { if (u) this.radarLayer?.setUrl(u) })
    }, 600000)
    return true
  }

  private async setForecast (on: boolean): Promise<boolean> {
    const map = this.map
    if (!map) return false
    window.clearInterval(this.forecastTimer)
    window.clearTimeout(this.forecastDebounce)
    this.forecastTimer = undefined
    map.off('moveend', this.onForecastMove, this)
    map.off('click', this.onForecastClick, this)
    if (!on) {
      this.forecastSeq++
      this.forecastOverlay?.remove()
      this.forecastOverlay = undefined
      this.forecastPopup?.remove()
      return true
    }
    const ok = await this.loadForecast()
    if (!ok || map !== this.map) return false
    map.on('moveend', this.onForecastMove, this)
    map.on('click', this.onForecastClick, this)
    // Open-Meteo models update hourly
    this.forecastTimer = window.setInterval(() => { void this.loadForecast() }, 3600000)
    return true
  }

  private onForecastMove = (): void => {
    window.clearTimeout(this.forecastDebounce)
    this.forecastDebounce = window.setTimeout(() => { void this.loadForecast() }, 700)
  }

  private async loadForecast (): Promise<boolean> {
    const map = this.map
    if (!map) return false
    const seq = ++this.forecastSeq
    const bounds = map.getBounds().pad(0.2)
    const sw = L.CRS.EPSG3857.project(bounds.getSouthWest())
    const ne = L.CRS.EPSG3857.project(bounds.getNorthEast())
    const lats: string[] = []
    const lons: string[] = []
    // Evenly spaced in map (Mercator) space so the colour wash lines up with the image bounds
    for (let r = 0; r < FORECAST_ROWS; r++) {
      for (let c = 0; c < FORECAST_COLS; c++) {
        const ll = L.CRS.EPSG3857.unproject(L.point(
          sw.x + (ne.x - sw.x) * c / (FORECAST_COLS - 1),
          sw.y + (ne.y - sw.y) * r / (FORECAST_ROWS - 1)
        ))
        lats.push(Math.max(-89, Math.min(89, ll.lat)).toFixed(2))
        lons.push(ll.lng.toFixed(2))
      }
    }
    const url = `${FORECAST_API}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
      `&hourly=temperature_2m,precipitation_probability&forecast_hours=${FORECAST_HOURS}&timezone=auto`
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as unknown
      const list = (Array.isArray(json) ? json : [json]) as Array<{ hourly: { time: string[], temperature_2m: number[], precipitation_probability: number[] } }>
      if (seq !== this.forecastSeq || map !== this.map) return true
      if (list.length !== FORECAST_COLS * FORECAST_ROWS) throw new Error('unexpected response')
      this.forecastGrid = {
        cols: FORECAST_COLS,
        rows: FORECAST_ROWS,
        bounds,
        times: list[0].hourly.time,
        temp: list.map(d => d.hourly.temperature_2m),
        pop: list.map(d => d.hourly.precipitation_probability)
      }
      this.drawForecast()
      return true
    } catch (err) {
      console.warn('earthquake-map-card: could not load forecast', err)
      return false
    }
  }

  private drawForecast (): void {
    const map = this.map
    const g = this.forecastGrid
    if (!map || !g || !this.forecastOn) return
    const sw = L.CRS.EPSG3857.project(g.bounds.getSouthWest())
    const ne = L.CRS.EPSG3857.project(g.bounds.getNorthEast())
    const w = 160
    const h = Math.max(40, Math.min(240, Math.round(w * (ne.y - sw.y) / (ne.x - sw.x))))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(w, h)
    const i = this.forecastHour
    const metric = this.forecastMetric
    const values = (metric === 'temp' ? g.temp : g.pop).map(series => series[i] ?? 0)
    for (let py = 0; py < h; py++) {
      const gy = (1 - py / (h - 1)) * (g.rows - 1)
      const r0 = Math.min(g.rows - 2, Math.floor(gy))
      const fy = gy - r0
      for (let px = 0; px < w; px++) {
        const gx = px / (w - 1) * (g.cols - 1)
        const c0 = Math.min(g.cols - 2, Math.floor(gx))
        const fx = gx - c0
        const at = (r: number, c: number): number => values[r * g.cols + c]
        const v = (at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx) * (1 - fy) + (at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx) * fy
        const o = (py * w + px) * 4
        if (metric === 'temp') {
          const [cr, cg, cb] = tempColor(v)
          img.data[o] = cr; img.data[o + 1] = cg; img.data[o + 2] = cb; img.data[o + 3] = 255
        } else {
          img.data[o] = 40; img.data[o + 1] = 110; img.data[o + 2] = 255; img.data[o + 3] = Math.round(Math.max(0, Math.min(1, v / 100)) * 255)
        }
      }
    }
    ctx.putImageData(img, 0, 0)
    const url = canvas.toDataURL('image/png')
    if (this.forecastOverlay) {
      this.forecastOverlay.setBounds(g.bounds)
      this.forecastOverlay.setUrl(url)
    } else {
      const pane = map.getPane('forecast') ?? map.createPane('forecast')
      pane.style.zIndex = '250'
      pane.style.pointerEvents = 'none'
      this.forecastOverlay = L.imageOverlay(url, g.bounds, { opacity: 0.5, pane: 'forecast', attribution: 'Forecast: Open-Meteo' }).addTo(map)
    }
    const t = g.times[i]
    if (this.forecastLabel && t) {
      this.forecastLabel.textContent = i === 0 ? 'Now' : `+${i}h \u00B7 ${new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
    }
  }

  private onForecastClick = (e: L.LeafletMouseEvent): void => {
    const map = this.map
    if (!map || !this.forecastOn) return
    const target = e.originalEvent.target as HTMLElement | null
    if (target?.closest('.leaflet-interactive, .leaflet-popup, .leaflet-control')) return
    const popup = L.popup({ maxWidth: 420, minWidth: 280 }).setLatLng(e.latlng)
    const loading = document.createElement('div')
    loading.style.cssText = 'color:#333;font:12px sans-serif'
    loading.textContent = 'Loading forecast\u2026'
    popup.setContent(loading).openOn(map)
    this.forecastPopup = popup
    const start = this.forecastHour
    const url = `${FORECAST_API}?latitude=${e.latlng.lat.toFixed(3)}&longitude=${e.latlng.lng.toFixed(3)}` +
      `&hourly=temperature_2m,precipitation_probability,weather_code&forecast_hours=${FORECAST_HOURS}&timezone=auto`
    void fetch(url).then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json() as { hourly: { time: string[], temperature_2m: number[], precipitation_probability: number[], weather_code: number[] } }
      popup.setContent(this.buildForecastStrip(d.hourly, start))
    }).catch(() => { loading.textContent = 'Forecast unavailable' })
  }

  private buildForecastStrip (h: { time: string[], temperature_2m: number[], precipitation_probability: number[], weather_code: number[] }, start: number): HTMLElement {
    const root = document.createElement('div')
    root.style.cssText = 'color:#222;font:12px/1.3 sans-serif'
    const title = document.createElement('div')
    title.style.cssText = 'font-weight:600;margin-bottom:6px'
    title.textContent = 'Forecast from ' + (h.time[start] ? new Date(h.time[start]).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'now')
    const strip = document.createElement('div')
    strip.style.cssText = 'display:flex;gap:2px;justify-content:space-between'
    for (let k = 0; k < 8; k++) {
      const idx = start + k * 3
      const t = h.temperature_2m[idx]
      if (t === undefined) break
      const col = document.createElement('div')
      col.style.cssText = 'flex:1;text-align:center;min-width:32px'
      const time = document.createElement('div')
      time.style.cssText = 'color:#666;font-size:11px'
      time.textContent = new Date(h.time[idx]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const icon = document.createElement('div')
      icon.style.fontSize = '20px'
      icon.textContent = weatherEmoji(h.weather_code[idx] ?? 0)
      const temp = document.createElement('div')
      temp.style.fontWeight = '600'
      temp.textContent = `${Math.round(t)}\u00B0`
      const pop = h.precipitation_probability[idx] ?? 0
      const bar = document.createElement('div')
      bar.style.cssText = 'height:34px;display:flex;align-items:flex-end;justify-content:center;margin-top:2px'
      const fill = document.createElement('div')
      fill.style.cssText = `width:14px;border-radius:3px 3px 0 0;background:#2e7bff;height:${Math.max(2, Math.round(pop * 0.34))}px`
      bar.append(fill)
      const pct = document.createElement('div')
      pct.style.cssText = 'color:#2e7bff;font-size:11px'
      pct.textContent = `${pop}%`
      col.append(time, icon, temp, bar, pct)
      strip.append(col)
    }
    root.append(title, strip)
    return root
  }

  private drawWarnings (): void {
    const map = this.map
    if (!map) return
    this.warningLayer?.remove()
    this.warningLayer = undefined
    if (!this.warningsOn || !this.config?.warnings_entity) return
    const entries = this.hass?.states[this.config.warnings_entity]?.attributes?.entries as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(entries)) return
    const group = L.layerGroup()
    const now = Date.now()
    const str = (v: unknown): string => typeof v === 'string' ? v : ''
    for (const e of entries) {
      const expires = Date.parse(str(e.cap_expires ?? e.expires))
      if (Number.isFinite(expires) && expires < now) continue
      const coords = parsePolygon(str(e.cap_polygon ?? e.polygon))
      if (coords.length < 3) continue
      const title = str(e.title)
      const color = warningColor(title, str(e.cap_severity ?? e.severity))
      const poly = L.polygon(coords, { color, weight: 3, fillColor: color, fillOpacity: 0.3 })
      const box = document.createElement('div')
      const name = document.createElement('strong')
      name.textContent = str(e.cap_event ?? e.event) || title
      box.append(name)
      const area = str(e.cap_areadesc ?? e.areaDesc)
      if (area) box.append(document.createElement('br'), document.createTextNode(area))
      if (Number.isFinite(expires)) box.append(document.createElement('br'), document.createTextNode(`Until ${new Date(expires).toLocaleString()}`))
      poly.bindPopup(box)
      group.addLayer(poly)
    }
    group.addTo(map)
    this.warningLayer = group
  }

  private updateRadius (): void {
    if (!this.map || this.config?.show_radius === false) return
    const entityId = this.config?.radius_entity ?? 'input_number.earthquake_radius_km'
    const km = Number(this.hass?.states[entityId]?.state)
    const home = this.getHome()
    if (!Number.isFinite(km) || km <= 0 || !home) {
      this.radiusLayer?.remove()
      this.radiusLayer = undefined
      return
    }
    if (!this.radiusLayer) {
      this.radiusLayer = L.circle(home, { radius: km * 1000, color: '#FFFFFF', weight: 2, dashArray: '8 6', fill: false, interactive: false }).addTo(this.map)
    } else {
      this.radiusLayer.setLatLng(home)
      this.radiusLayer.setRadius(km * 1000)
    }
  }

  private drawMarkers (): void {
    if (!this.map || !this.markerLayer) return
    this.markerLayer.clearLayers()
    this.markers.clear()
    const quakes = this.getQuakes()

    for (const q of quakes) {
      const marker = L.circleMarker([q.lat, q.lon], {
        radius: Math.min(22, 5 + Math.max(0, q.magnitude) * 4),
        color: '#FFFFFF',
        weight: 1.5,
        fillColor: magnitudeColor(q.magnitude),
        fillOpacity: 0.7
      })
      marker.bindPopup(this.popupContent(q))
      marker.on('click', () => { this.select(q.id, false) })
      marker.addTo(this.markerLayer)
      this.markers.set(q.id, marker)
    }
  }

  private popupContent (q: Quake): HTMLElement {
    // Built with textContent so feed text can never inject markup
    const root = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = `M ${q.magnitude.toFixed(1)} - ${q.place || 'Unknown location'}`
    root.appendChild(title)
    const lines = [
      Number.isFinite(q.time) ? new Date(q.time).toLocaleString() : '',
      q.depth ? `Depth ${q.depth}` : '',
      q.distanceKm !== null ? `${Math.round(q.distanceKm)} km from home` : ''
    ].filter(Boolean)
    for (const line of lines) {
      const div = document.createElement('div')
      div.textContent = line
      root.appendChild(div)
    }
    if (q.link.startsWith('http')) {
      const a = document.createElement('a')
      a.href = q.link
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = 'BGS details'
      root.appendChild(a)
    }
    return root
  }

  private select (id: string, fromList: boolean): void {
    this.selectedId = id
    const marker = this.markers.get(id)
    if (marker && fromList && this.map) {
      this.map.flyTo(marker.getLatLng(), Math.max(this.map.getZoom(), 9), { duration: 0.8 })
      marker.openPopup()
    }
    if (!fromList) {
      void this.updateComplete.then(() => {
        const row = Array.from(this.renderRoot.querySelectorAll<HTMLElement>('.row')).find(r => r.dataset.id === id)
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    }
  }
}
