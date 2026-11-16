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
}

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

  private map?: L.Map
  private markerLayer?: L.LayerGroup
  private markers = new Map<string, L.CircleMarker>()
  private resizeObserver?: ResizeObserver
  private lastEntries?: unknown

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
  }

  public getCardSize (): number {
    return Math.ceil((this.config?.height ?? 500) / 50)
  }

  public static getStubConfig (): Record<string, unknown> {
    return { entity: 'sensor.bgs_uk_earthquakes' }
  }

  private getQuakes (): Quake[] {
    const entityId = this.config?.entity
    if (!entityId || !this.hass) return []
    const entries = this.hass.states[entityId]?.attributes?.entries as Array<Record<string, string>> | undefined
    if (!Array.isArray(entries)) return []

    const zone = this.hass.states[this.config?.home_entity ?? 'zone.home']
    const homeLat = Number(zone?.attributes?.latitude ?? this.hass.config?.latitude)
    const homeLon = Number(zone?.attributes?.longitude ?? this.hass.config?.longitude)
    const haveHome = Number.isFinite(homeLat) && Number.isFinite(homeLon)

    const quakes: Quake[] = []
    for (const e of entries) {
      const lat = parseFloat(e.geo_lat)
      const lon = parseFloat(e.geo_long)
      const summary = e.summary ?? ''
      const mag = parseFloat(summary.split('Magnitude:')[1] ?? '')
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(mag)) continue
      const place = /Location:\s*([^;]+);/.exec(summary)?.[1]?.trim() ?? ''
      const depth = /Depth:\s*([^;]+);/.exec(summary)?.[1]?.trim() ?? ''
      // BGS publishes times without a zone; they are UTC
      const time = Date.parse(`${e.published ?? ''} GMT`)
      quakes.push({
        id: e.link ?? `${lat},${lon},${e.published}`,
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
            ${quakes.length === 0
              ? html`<div class="empty">No earthquakes in the feed.</div>`
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
    if (this.map && (entries !== this.lastEntries || changedProps.has('config'))) {
      this.lastEntries = entries
      this.drawMarkers()
    }
  }

  public disconnectedCallback (): void {
    super.disconnectedCallback()
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    this.map?.remove()
    this.map = undefined
    this.markerLayer = undefined
    this.markers.clear()
    this.lastEntries = undefined
  }

  private initMap (): void {
    const container = this.renderRoot.querySelector<HTMLElement>('.map')
    if (!container) return
    const zone = this.hass?.states[this.config?.home_entity ?? 'zone.home']
    const homeLat = Number(zone?.attributes?.latitude ?? this.hass?.config?.latitude)
    const homeLon = Number(zone?.attributes?.longitude ?? this.hass?.config?.longitude)
    const lat = this.config?.latitude ?? (Number.isFinite(homeLat) ? homeLat : 54.5)
    const lon = this.config?.longitude ?? (Number.isFinite(homeLon) ? homeLon : -3)
    this.map = L.map(container, { zoomSnap: 0.5, worldCopyJump: true }).setView([lat, lon], this.config?.zoom ?? 8)
    L.tileLayer(SATELLITE_URL, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(this.map)
    L.tileLayer(LABELS_URL, { maxZoom: 18 }).addTo(this.map)
    this.markerLayer = L.layerGroup().addTo(this.map)
    this.resizeObserver = new ResizeObserver(() => { this.map?.invalidateSize() })
    this.resizeObserver.observe(container)
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
