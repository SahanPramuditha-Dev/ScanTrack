import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const DEFAULT_ZOOM = 18
const ROAD_TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
const ROAD_TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO'
const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const SATELLITE_TILE_ATTRIBUTION = 'Tiles &copy; Esri'

async function searchPlaces(query) {
  const trimmed = String(query || '').trim()
  if (!trimmed) return []

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    limit: '6',
    addressdetails: '1',
  })

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error('Search is unavailable right now.')
  }

  const rows = await response.json()
  return Array.isArray(rows) ? rows : []
}

async function reverseLookup(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return ''

  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: 'jsonv2',
    zoom: '18',
  })

  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) return ''
  const row = await response.json()
  return String(row?.display_name || '').trim()
}

export function MapPicker({ lat, lng, radius = 0, onLocationSelect, className = '' }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const radiusRef = useRef(null)
  const tileLayerRef = useRef(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [results, setResults] = useState([])
  const [placeLabel, setPlaceLabel] = useState('')
  const [mapMode, setMapMode] = useState('road')

  const googleMapsUrl = useMemo(
    () => `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`,
    [lat, lng],
  )

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined

    const map = L.map(containerRef.current, {
      zoomControl: true,
      scrollWheelZoom: true,
    }).setView([lat, lng], DEFAULT_ZOOM)

    const tileLayer = L.tileLayer(ROAD_TILE_URL, {
      attribution: ROAD_TILE_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map)

    const marker = L.marker([lat, lng], { draggable: true }).addTo(map)
    const radiusCircle = L.circle([lat, lng], {
      radius: Math.max(0, Number(radius) || 0),
      color: '#1f8fff',
      weight: 2,
      fillColor: '#1f8fff',
      fillOpacity: 0.12,
    }).addTo(map)

    marker.on('dragend', (event) => {
      const { lat: newLat, lng: newLng } = event.target.getLatLng()
      onLocationSelect(newLat, newLng)
    })

    map.on('click', (event) => {
      const { lat: newLat, lng: newLng } = event.latlng
      onLocationSelect(newLat, newLng)
    })

    mapRef.current = map
    markerRef.current = marker
    radiusRef.current = radiusCircle
    tileLayerRef.current = tileLayer

    requestAnimationFrame(() => map.invalidateSize())

    return () => {
      map.remove()
      mapRef.current = null
      markerRef.current = null
      radiusRef.current = null
      tileLayerRef.current = null
    }
  }, [lat, lng, onLocationSelect, radius])

  useEffect(() => {
    if (!mapRef.current || !markerRef.current || !radiusRef.current) return

    const nextLatLng = L.latLng(lat, lng)
    markerRef.current.setLatLng(nextLatLng)
    radiusRef.current.setLatLng(nextLatLng)
  }, [lat, lng])

  useEffect(() => {
    if (!radiusRef.current || !mapRef.current) return
    const safeRadius = Math.max(0, Number(radius) || 0)
    radiusRef.current.setRadius(safeRadius)
  }, [radius])

  useEffect(() => {
    if (!mapRef.current || !tileLayerRef.current) return

    mapRef.current.removeLayer(tileLayerRef.current)
    const isSatellite = mapMode === 'satellite'
    const nextLayer = L.tileLayer(isSatellite ? SATELLITE_TILE_URL : ROAD_TILE_URL, {
      attribution: isSatellite ? SATELLITE_TILE_ATTRIBUTION : ROAD_TILE_ATTRIBUTION,
      subdomains: isSatellite ? undefined : 'abcd',
      maxZoom: 20,
    }).addTo(mapRef.current)

    tileLayerRef.current = nextLayer
  }, [mapMode])

  useEffect(() => {
    if (!mapRef.current || !radiusRef.current) return
    const safeRadius = Math.max(0, Number(radius) || 0)
    if (safeRadius > 0) {
      mapRef.current.fitBounds(radiusRef.current.getBounds(), { padding: [28, 28] })
    } else {
      mapRef.current.setView([lat, lng], DEFAULT_ZOOM, { animate: true })
    }
  }, [lat, lng, radius])

  useEffect(() => {
    const timer = setTimeout(() => {
      reverseLookup(lat, lng).then((label) => setPlaceLabel(label)).catch(() => setPlaceLabel(''))
    }, 350)
    return () => clearTimeout(timer)
  }, [lat, lng])

  const runSearch = async () => {
    const trimmed = String(query || '').trim()
    if (!trimmed) {
      setResults([])
      setSearchError('Enter a place, address, or landmark.')
      return
    }

    setSearching(true)
    setSearchError('')
    try {
      const rows = await searchPlaces(trimmed)
      setResults(rows)
      if (!rows.length) {
        setSearchError('No locations found. Try a more specific search.')
      }
    } catch (error) {
      setResults([])
      setSearchError(error.message || 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  const selectResult = (item) => {
    const newLat = Number(item?.lat)
    const newLng = Number(item?.lon)
    if (!Number.isFinite(newLat) || !Number.isFinite(newLng)) return
    setQuery(String(item?.display_name || ''))
    setResults([])
    setSearchError('')
    onLocationSelect(newLat, newLng)
    if (mapRef.current) {
      mapRef.current.setView([newLat, newLng], DEFAULT_ZOOM, { animate: true })
    }
  }

  const fitRadius = () => {
    if (!mapRef.current || !radiusRef.current) return
    const safeRadius = Math.max(0, Number(radius) || 0)
    if (safeRadius > 0) {
      mapRef.current.fitBounds(radiusRef.current.getBounds(), { padding: [28, 28] })
    } else {
      mapRef.current.setView([lat, lng], DEFAULT_ZOOM, { animate: true })
    }
  }

  return (
    <div className={`map-picker ${className}`}>
      <div className="map-picker-toolbar">
        <div className="map-picker-search">
          <input
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              if (searchError) setSearchError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch()
              }
            }}
            placeholder="Search by address, place, or landmark"
          />
          <button type="button" className="ghost btn-sm" onClick={runSearch} disabled={searching}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
        <div className="map-picker-actions">
          <div className="map-picker-mode" role="group" aria-label="Map style">
            <button
              type="button"
              className={`ghost btn-sm ${mapMode === 'road' ? 'active' : ''}`}
              onClick={() => setMapMode('road')}
            >
              Map
            </button>
            <button
              type="button"
              className={`ghost btn-sm ${mapMode === 'satellite' ? 'active' : ''}`}
              onClick={() => setMapMode('satellite')}
            >
              Satellite
            </button>
          </div>
          <button type="button" className="ghost btn-sm" onClick={fitRadius}>Fit radius</button>
          <a className="ghost btn-sm" href={googleMapsUrl} target="_blank" rel="noreferrer">
            Large map
          </a>
        </div>
      </div>

      {searchError ? <p className="map-picker-feedback">{searchError}</p> : null}
      {placeLabel ? <p className="map-picker-place">{placeLabel}</p> : null}

      {results.length ? (
        <div className="map-picker-results">
          {results.map((item) => (
            <button
              type="button"
              key={`${item.place_id}-${item.lat}-${item.lon}`}
              className="map-picker-result"
              onClick={() => selectResult(item)}
            >
              <strong>{String(item?.display_name || '').split(',')[0] || 'Selected place'}</strong>
              <span>{item?.display_name}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div ref={containerRef} style={{ height: '320px', width: '100%' }} />
    </div>
  )
}
