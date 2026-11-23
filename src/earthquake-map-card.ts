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
  show_clouds?: boolean
}

type TimeRange = '24h' | '7d' | '30d' | 'all'

const RANGES: Array<{ id: TimeRange, label: string, ms: number }> = [
  { id: '24h', label: '24h', ms: 24 * 3600000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 3600000 },
  { id: '30d', label: '30d', ms: 30 * 24 * 3600000 },
  { id: 'all', label: 'All', ms: Infinity }
]

const CLOUD_WMS_URL = 'https://view.eumetsat.int/geoserver/wms'
const CLOUD_LAYER = 'msg_fes:ir108'
const CLOUD_DOWNSCALE = 6
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
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
  private overlayLayers: { radar?: L.Layer, cloud?: L.Layer } = {}
  private overlayTimers: { radar?: number, cloud?: number } = {}

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
    this.updateRadius()
  }

  public disconnectedCallback (): void {
    super.disconnectedCallback()
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    window.clearInterval(this.overlayTimers.radar)
    window.clearInterval(this.overlayTimers.cloud)
    this.overlayTimers = {}
    this.overlayLayers = {}
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
        const overlays: Array<{ id: 'radar' | 'cloud', label: string, initial: boolean }> = [
          { id: 'radar', label: 'Rain radar', initial: this.config?.show_radar === true },
          { id: 'cloud', label: 'Cloud cover', initial: this.config?.show_clouds === true }
        ]
        for (const o of overlays) {
          const row = document.createElement('div')
          const label = document.createElement('label')
          label.style.cursor = 'pointer'
          const input = document.createElement('input')
          input.type = 'checkbox'
          input.style.verticalAlign = 'middle'
          label.append(input, ` ${o.label}`)
          const status = document.createElement('div')
          status.style.cssText = 'color:#b00020;display:none'
          row.append(label, status)
          box.append(row)
          const apply = (): void => {
            void this.setOverlay(o.id, input.checked).then(ok => {
              status.style.display = ok ? 'none' : 'block'
              status.textContent = ok ? '' : `${o.label} unavailable`
              if (!ok) input.checked = false
            })
          }
          input.addEventListener('change', apply)
          if (o.initial) {
            input.checked = true
            apply()
          }
        }
        return box
      }
    })
    new Control({ position: 'topright' }).addTo(map)
  }

  private async setOverlay (id: 'radar' | 'cloud', on: boolean): Promise<boolean> {
    const map = this.map
    if (!map) return false
    window.clearInterval(this.overlayTimers[id])
    this.overlayTimers[id] = undefined
    if (!on) {
      this.overlayLayers[id]?.remove()
      if (id === 'cloud') map.off('moveend', this.updateCloud, this)
      return true
    }
    let layer = this.overlayLayers[id]
    if (id === 'radar') {
      const url = await this.fetchRadarUrl()
      if (!url || map !== this.map) return false
      if (layer) {
        (layer as L.TileLayer).setUrl(url)
      } else {
        layer = L.tileLayer(url, { opacity: 0.6, maxZoom: 18, maxNativeZoom: 7, attribution: 'Radar: RainViewer' })
      }
    } else if (!layer) {
      // One image covering the view (no tile seams). "screen" blending keeps only the bright (cloudy) pixels visible
      const pane = map.getPane('cloud') ?? map.createPane('cloud')
      pane.style.mixBlendMode = 'screen'
      pane.style.zIndex = '250'
      pane.style.pointerEvents = 'none'
      layer = L.imageOverlay(TRANSPARENT_PIXEL, map.getBounds(), {
        opacity: 0.9,
        pane: 'cloud',
        attribution: 'Cloud: EUMETSAT'
      })
    }
    this.overlayLayers[id] = layer
    layer.addTo(map)
    if (id === 'cloud') {
      map.on('moveend', this.updateCloud, this)
      this.updateCloud()
    }
    // Radar frames update about every 10 minutes, MSG images every 15
    this.overlayTimers[id] = window.setInterval(() => {
      if (id === 'radar') {
        void this.fetchRadarUrl().then(u => { if (u) (this.overlayLayers.radar as L.TileLayer | undefined)?.setUrl(u) })
      } else {
        this.updateCloud()
      }
    }, id === 'radar' ? 600000 : 900000)
    return true
  }

  private updateCloud = (): void => {
    const map = this.map
    const overlay = this.overlayLayers.cloud as L.ImageOverlay | undefined
    if (!map || !overlay) return
    const bounds = map.getBounds().pad(0.25)
    const sw = L.CRS.EPSG3857.project(bounds.getSouthWest())
    const ne = L.CRS.EPSG3857.project(bounds.getNorthEast())
    const size = map.getSize()
    // Request a coarse image (about the satellite's real resolution) and let the browser smooth it
    const w = Math.max(64, Math.round(size.x * 1.5 / CLOUD_DOWNSCALE))
    const h = Math.max(64, Math.round(size.y * 1.5 / CLOUD_DOWNSCALE))
    const url = `${CLOUD_WMS_URL}?service=WMS&version=1.3.0&request=GetMap&layers=${CLOUD_LAYER}&styles=&format=image/png&crs=EPSG:3857` +
      `&bbox=${sw.x},${sw.y},${ne.x},${ne.y}&width=${w}&height=${h}&_=${Math.floor(Date.now() / 900000)}`
    const img = new Image()
    img.onload = () => {
      if (map !== this.map || this.overlayLayers.cloud !== overlay) return
      overlay.setBounds(bounds)
      overlay.setUrl(url)
    }
    img.src = url
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
