/**
 * Place Correspondence Map Prototype (`place-letters-map.js`)
 *
 * Plots letters written FROM and TO a selected Place (defaulting to Rouen, `letters.place:448`)
 * using Leaflet (matching `backend/app/core/static/js/map-editor.js` and `wagtail_hooks.py`),
 * with quadratic Bézier curved connecting arcs, directional indicators, interactive
 * From/To toggles, and live Typesense query execution + fallback snapshot.
 */

(function () {
    "use strict";

    const DATA = window.MONET_PLACE_MAP_DATA || {
        default_place_id: "letters.place:448",
        places: {},
        letters: [],
        rouen_db_stubs: [],
    };

    const COLORS = {
        primary: "#cd3238",       // Highlighted primary place dot (crimson accent)
        primaryRing: "#fefbf4",   // --color-monet-page
        outbound: "#19599a",      // --color-monet-link (Monet Cobalt Blue)
        inbound: "#b45309",       // Warm Ochre / Sienna for contrasting inbound flow
        bidirectional: "#124574", // --color-monet-deep-blue
        inferred: "#19599a",
        boundary: "#918477",      // --color-monet-control-border
    };

    const state = {
        selectedPlaceId: DATA.default_place_id || "letters.place:448",
        showOutbound: true,       // Letters Sent FROM primary place
        showInbound: true,        // Letters Sent TO primary place
        includeDbStubs: true,     // Include the 6 DB stub letters for Rouen (28 From total)
        inferUnplacedGiverny: false, // UX option: plot unplaced Rouen->Alice letters to Giverny
        animateFlow: true,        // Animate directional dashes along curved arcs
        selectedRouteKey: null,   // e.g. "OUT|letters.place:434" or "IN|letters.place:439" or "UNPLACED"
        liveTypesenseStatus: "checking", // "live" | "snapshot" | "checking"
        liveLettersOverride: null,
        lastTypesenseResponse: null,
    };

    // --- Initialize Leaflet Map ---
    const defaultPlace = DATA.places[state.selectedPlaceId] || {
        lat: 49.443232,
        lng: 1.099971,
    };

    const map = L.map("map", {
        zoomControl: false,
        preferCanvas: false,
    }).setView([defaultPlace.lat, defaultPlace.lng], 7);

    L.control.zoom({ position: "topright" }).addTo(map);

    // Base Tile Layers (Carto Positron for clean editorial design + standard OSM from settings.py + Historic Rumsey)
    const cartoLight = L.tileLayer('https://api.maptiler.com/maps/positron/{z}/{x}/{y}.png?key=Lq8508I7odKgD3CEFzPK', {
          tileSize: 512,
          zoomOffset: -1,
          attribution: '&copy; MapTiler &copy; OpenStreetMap contributors'
        }).addTo(map);

    const osmStandard = L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution:
                '&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19,
            crossOrigin: true,
        }
    );

    const historicRumsey = L.tileLayer(
        "https://wmts.oldmapsonline.org/maps/ab4d28a9-1eaf-5bfd-87a4-d34eee36a0d4/2020-05-13T19:46:30.857572Z/{z}/{x}/{y}.png?key=qJwAhmp2Sv5TW8FU2jup",
        {
            attribution: "Historical Map &copy; David Rumsey Map Collection",
            opacity: 0.78,
            minZoom: 4,
            maxNativeZoom: 12,
            maxZoom: 19,
        }
    );

    const boundaryLayerGroup = L.layerGroup().addTo(map);
    const arcsLayerGroup = L.layerGroup().addTo(map);
    const markersLayerGroup = L.layerGroup().addTo(map);

    L.control
        .layers(
            {
                "Editorial Light (Carto Positron)": cartoLight,
                "Standard OpenStreetMap (Admin Default)": osmStandard,
                "19th-Century Historical Overlay (Rumsey)": historicRumsey,
            },
            {
                "Primary Place Boundary (GeoJSON)": boundaryLayerGroup,
                "Curved Correspondence Arcs": arcsLayerGroup,
                "Place Dots & Labels": markersLayerGroup,
            },
            { position: "topright", collapsed: true }
        )
        .addTo(map);

    // --- Quadratic Bézier Curved Line Geometry ---
    /**
     * Generates a smooth quadratic Bézier curve between `start` and `end`.
     * Always offsets the control point to the right-hand side of the directed
     * vector (start -> end) so that bidirectional routes (A -> B and B -> A)
     * automatically curve on opposite sides and never overlap.
     */
    function computeQuadraticCurve(startLatLng, endLatLng, curvature = 0.22, numPoints = 64) {
        const lat1 = startLatLng[0];
        const lng1 = startLatLng[1];
        const lat2 = endLatLng[0];
        const lng2 = endLatLng[1];

        const midLat = (lat1 + lat2) / 2;
        const midLng = (lng1 + lng2) / 2;

        // Adjust longitude delta by cos(midLat) so perpendicular offset looks visually uniform
        const cosLat = Math.cos((midLat * Math.PI) / 180) || 1;
        const dLat = lat2 - lat1;
        const dLngScaled = (lng2 - lng1) * cosLat;
        const dist = Math.hypot(dLat, dLngScaled);

        if (dist < 1e-5) {
            return {
                points: [startLatLng, endLatLng],
                midpoint: [midLat, midLng],
                angleDeg: 0,
            };
        }

        // Unit perpendicular vector (to the right of the travel direction)
        const perpLat = -dLngScaled / dist;
        const perpLngScaled = dLat / dist;

        const offset = dist * curvature;
        const ctrlLat = midLat + perpLat * offset;
        const ctrlLng = midLng + (perpLngScaled * offset) / cosLat;

        const points = [];
        for (let i = 0; i <= numPoints; i++) {
            const t = i / numPoints;
            const invT = 1 - t;
            const lat =
                invT * invT * lat1 + 2 * invT * t * ctrlLat + t * t * lat2;
            const lng =
                invT * invT * lng1 + 2 * invT * t * ctrlLng + t * t * lng2;
            points.push([lat, lng]);
        }

        // Midpoint and tangent at t = 0.52 (slightly past middle for clean arrowhead placement)
        const tMid = 0.52;
        const invTMid = 1 - tMid;
        const arrowLat =
            invTMid * invTMid * lat1 +
            2 * invTMid * tMid * ctrlLat +
            tMid * tMid * lat2;
        const arrowLng =
            invTMid * invTMid * lng1 +
            2 * invTMid * tMid * ctrlLng +
            tMid * tMid * lng2;

        // Derivative B'(t) = 2(1-t)(P1 - P0) + 2t(P2 - P1)
        const dLatDt =
            2 * invTMid * (ctrlLat - lat1) + 2 * tMid * (lat2 - ctrlLat);
        const dLngDtScaled =
            (2 * invTMid * (ctrlLng - lng1) + 2 * tMid * (lng2 - ctrlLng)) *
            cosLat;
        // Screen angle where 0deg = East, -90deg = North
        const angleDeg = (Math.atan2(-dLatDt, dLngDtScaled) * 180) / Math.PI;

        return {
            points,
            midpoint: [arrowLat, arrowLng],
            angleDeg,
        };
    }

    // --- Typesense Query Builder & Live Fetcher ---
    function buildTypesenseQueryParams(placeId, showOutbound, showInbound) {
        const filters = [];
        if (showOutbound) {
            filters.push(
                `relationships.relationship_id:=letters.letter|letters.place|written_from_place|${placeId}`
            );
        }
        if (showInbound) {
            filters.push(
                `relationships.relationship_id:=letters.letter|letters.place|written_to_place|${placeId}`
            );
        }

        const filterBy =
            filters.length === 0
                ? "id:=__none__"
                : filters.length === 1
                ? filters[0]
                : `relationships.relationship_id:=[letters.letter|letters.place|written_from_place|${placeId}, letters.letter|letters.place|written_to_place|${placeId}]`;

        return {
            q: "*",
            filter_by: filterBy,
            facet_by: "relationships.relationship_id",
            facet_return_parent: "relationships.relationship_id",
            max_facet_values: "200",
            per_page: "250",
            include_fields:
                "id,identifier,w_id,date,display_date,title,subject,pull_quote,relationships",
        };
    }

    function formatYyyymmdd(ts) {
        if (!ts) return "";
        const n = Number(ts);
        const year = Math.floor(n / 10000);
        const rem = n % 10000;
        const month = String(Math.floor(rem / 100)).padStart(2, "0");
        const day = String(rem % 100).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function normalizeTypesenseHit(hit) {
        const doc = hit.document || {};
        const rels = doc.relationships || [];
        const fromPlaces = rels.filter(
            (r) =>
                r.relationship_type ===
                "letters.letter|letters.place|written_from_place"
        );
        const toPlaces = rels.filter(
            (r) =>
                r.relationship_type ===
                "letters.letter|letters.place|written_to_place"
        );
        const writers = rels
            .filter(
                (r) =>
                    r.relationship_type ===
                    "letters.letter|letters.person|written_by"
            )
            .map((r) => (r.label && (r.label.en || r.label.fr)) || "")
            .filter(Boolean);
        const recipients = rels
            .filter(
                (r) =>
                    r.relationship_type ===
                    "letters.letter|letters.person|written_to"
            )
            .map((r) => (r.label && (r.label.en || r.label.fr)) || "")
            .filter(Boolean);

        const dateObj = doc.date || {};
        const displayDate =
            (doc.display_date && (doc.display_date.en || doc.display_date.fr)) ||
            formatYyyymmdd(dateObj.start_timestamp);

        return {
            id: doc.id,
            identifier: String(doc.identifier || ""),
            w_id: String(doc.w_id || ""),
            date_str: displayDate,
            year: dateObj.histogram_year || null,
            written_by: writers,
            written_to: recipients,
            from_place_id: fromPlaces[0] ? fromPlaces[0].id : null,
            from_place_label:
                fromPlaces[0] && fromPlaces[0].label
                    ? fromPlaces[0].label.en || fromPlaces[0].label.fr
                    : null,
            to_place_id: toPlaces[0] ? toPlaces[0].id : null,
            to_place_label:
                toPlaces[0] && toPlaces[0].label
                    ? toPlaces[0].label.en || toPlaces[0].label.fr
                    : null,
            subject: (doc.subject && (doc.subject.en || doc.subject.fr)) || "",
            is_stub: false,
        };
    }

    async function tryLiveTypesenseQuery(placeId) {
        const params = buildTypesenseQueryParams(placeId, true, true);
        const searchParams = new URLSearchParams(params);
        const endpoints = [
            "http://monet-letters.localhost/_typesense/collections/letters/documents/search",
            "http://localhost:8108/collections/letters/documents/search",
        ];

        for (const base of endpoints) {
            try {
                const res = await fetch(`${base}?${searchParams.toString()}`, {
                    headers: { "X-TYPESENSE-API-KEY": "xyz" },
                });
                if (res.ok) {
                    const json = await res.json();
                    state.liveTypesenseStatus = "live";
                    state.lastTypesenseResponse = json;
                    state.liveLettersOverride = (json.hits || []).map(
                        normalizeTypesenseHit
                    );
                    updateStatusBadge(base);
                    renderAll(false);
                    return;
                }
            } catch (_err) {
                // Continue to next endpoint or snapshot fallback
            }
        }

        state.liveTypesenseStatus = "snapshot";
        state.liveLettersOverride = null;
        updateStatusBadge(null);
    }

    function updateStatusBadge(liveUrl) {
        const badge = document.getElementById("ts-connection-badge");
        if (!badge) return;
        if (state.liveTypesenseStatus === "live") {
            const shortHost = liveUrl.includes("monet-letters.localhost")
                ? "monet-letters.localhost/_typesense"
                : "localhost:8108";
            badge.className = "status-badge status-live";
            badge.innerHTML = `<span class="status-dot"></span> Live Typesense (${shortHost})`;
        } else {
            badge.className = "status-badge status-snapshot";
            badge.innerHTML = `<span class="status-dot"></span> Typesense Snapshot (Offline-ready)`;
        }
    }

    // --- Data Aggregation for Selected Place ---
    function getActiveLettersForPlace(placeId) {
        const baseLetters =
            state.liveLettersOverride && state.liveStatusPlaceId === placeId
                ? state.liveLettersOverride
                : DATA.letters.filter(
                      (l) =>
                          l.from_place_id === placeId ||
                          l.to_place_id === placeId
                  );

        let letters = baseLetters.map((l) => ({ ...l }));

        if (placeId === "letters.place:448" && state.includeDbStubs) {
            letters = letters.concat(
                (DATA.rouen_db_stubs || []).map((s) => ({ ...s }))
            );
        }

        // Optional UX toggle: infer Giverny (`letters.place:434`) for letters from Rouen
        // addressed to Alice Hoschedé when `to_place_id` is empty.
        if (state.inferUnplacedGiverny) {
            letters = letters.map((l) => {
                if (
                    l.from_place_id === placeId &&
                    !l.to_place_id &&
                    (l.written_to || []).some((name) =>
                        name.toLowerCase().includes("alice")
                    )
                ) {
                    return {
                        ...l,
                        to_place_id: "letters.place:434",
                        to_place_label: "Giverny (inferred from recipient)",
                        inferred_destination: true,
                    };
                }
                return l;
            });
        }

        return letters;
    }

    function computePlaceNetwork(placeId) {
        const letters = getActiveLettersForPlace(placeId);
        const outboundLetters = letters.filter(
            (l) => l.from_place_id === placeId
        );
        const inboundLetters = letters.filter((l) => l.to_place_id === placeId);

        // Group outbound by destination place
        const outboundRoutes = new Map();
        const unplacedOutbound = [];

        for (const l of outboundLetters) {
            if (l.to_place_id && l.to_place_id !== placeId && DATA.places[l.to_place_id]) {
                const key = l.to_place_id;
                if (!outboundRoutes.has(key)) {
                    outboundRoutes.set(key, {
                        direction: "OUT",
                        routeKey: `OUT|${key}`,
                        otherPlaceId: key,
                        otherPlace: DATA.places[key],
                        letters: [],
                        inferredCount: 0,
                    });
                }
                const group = outboundRoutes.get(key);
                group.letters.push(l);
                if (l.inferred_destination) group.inferredCount += 1;
            } else {
                unplacedOutbound.push(l);
            }
        }

        // Group inbound by origin place
        const inboundRoutes = new Map();
        const unplacedInbound = [];

        for (const l of inboundLetters) {
            if (l.from_place_id && l.from_place_id !== placeId && DATA.places[l.from_place_id]) {
                const key = l.from_place_id;
                if (!inboundRoutes.has(key)) {
                    inboundRoutes.set(key, {
                        direction: "IN",
                        routeKey: `IN|${key}`,
                        otherPlaceId: key,
                        otherPlace: DATA.places[key],
                        letters: [],
                        inferredCount: 0,
                    });
                }
                inboundRoutes.get(key).letters.push(l);
            } else {
                unplacedInbound.push(l);
            }
        }

        return {
            outboundLetters,
            inboundLetters,
            outboundRoutes: Array.from(outboundRoutes.values()).sort(
                (a, b) => b.letters.length - a.letters.length
            ),
            inboundRoutes: Array.from(inboundRoutes.values()).sort(
                (a, b) => b.letters.length - a.letters.length
            ),
            unplacedOutbound,
            unplacedInbound,
        };
    }

    // --- Map Rendering ---
    function renderMap(network, fitView = false) {
        boundaryLayerGroup.clearLayers();
        arcsLayerGroup.clearLayers();
        markersLayerGroup.clearLayers();

        const primaryPlace = DATA.places[state.selectedPlaceId];
        if (!primaryPlace) return;

        const primaryLatLng = [primaryPlace.lat, primaryPlace.lng];
        const boundsPoints = [primaryLatLng];

        // 1. Optional GeoJSON boundary for Primary Place (matching `map-editor.js`)
        if (primaryPlace.boundary_geojson) {
            L.geoJSON(primaryPlace.boundary_geojson, {
                style: {
                    color: COLORS.boundary,
                    weight: 2,
                    opacity: 0.65,
                    fillColor: COLORS.primary,
                    fillOpacity: 0.08,
                    dashArray: "5, 5",
                },
                interactive: false,
            }).addTo(boundaryLayerGroup);
        }

        // 2. Collect visible routes based on From / To toggles
        const visibleRoutes = [];
        if (state.showOutbound) {
            visibleRoutes.push(...network.outboundRoutes);
        }
        if (state.showInbound) {
            visibleRoutes.push(...network.inboundRoutes);
        }

        // Track connected places and their visible outbound/inbound counts
        const connectedPlacesMap = new Map();

        for (const route of visibleRoutes) {
            const other = route.otherPlace;
            if (!other) continue;
            const otherLatLng = [other.lat, other.lng];
            boundsPoints.push(otherLatLng);

            if (!connectedPlacesMap.has(other.id)) {
                connectedPlacesMap.set(other.id, {
                    place: other,
                    outCount: 0,
                    inCount: 0,
                    routes: [],
                });
            }
            const entry = connectedPlacesMap.get(other.id);
            if (route.direction === "OUT") {
                entry.outCount += route.letters.length;
            } else {
                entry.inCount += route.letters.length;
            }
            entry.routes.push(route);

            // Compute curved arc from Origin -> Destination
            const fromLatLng =
                route.direction === "OUT" ? primaryLatLng : otherLatLng;
            const toLatLng =
                route.direction === "OUT" ? otherLatLng : primaryLatLng;

            const curve = computeQuadraticCurve(fromLatLng, toLatLng, 0.22, 64);
            const isSelected = state.selectedRouteKey === route.routeKey;
            const baseColor =
                route.direction === "OUT" ? COLORS.outbound : COLORS.inbound;
            const count = route.letters.length;
            const weight = Math.min(
                9,
                2.8 + Math.log2(count + 1) * 1.65 + (isSelected ? 2 : 0)
            );

            // Subtle glow/shadow under arc
            const haloLine = L.polyline(curve.points, {
                color: isSelected ? "#0f172a" : baseColor,
                weight: weight + 5,
                opacity: isSelected ? 0.28 : 0.12,
                lineCap: "round",
                interactive: false,
            }).addTo(arcsLayerGroup);

            const classNames = ["correspondence-arc"];
            if (route.direction === "OUT") classNames.push("arc-outbound");
            else classNames.push("arc-inbound");
            if (state.animateFlow) classNames.push("arc-animated");
            if (route.inferredCount > 0 && route.inferredCount === count) {
                classNames.push("arc-inferred");
            }

            const arcLine = L.polyline(curve.points, {
                color: baseColor,
                weight: weight,
                opacity:
                    state.selectedRouteKey && !isSelected ? 0.42 : 0.92,
                lineCap: "round",
                dashArray: state.animateFlow ? "10, 7" : null,
                className: classNames.join(" "),
            }).addTo(arcsLayerGroup);

            const directionLabel =
                route.direction === "OUT"
                    ? `Sent from ${primaryPlace.name} to ${other.name}`
                    : `Sent from ${other.name} to ${primaryPlace.name}`;

            arcLine.bindTooltip(
                `<div class="map-tooltip">
                    <div class="map-tooltip-title">${
                        route.direction === "OUT"
                            ? `${primaryPlace.name} &rarr; ${other.name}`
                            : `${other.name} &rarr; ${primaryPlace.name}`
                    }</div>
                    <div class="map-tooltip-sub">${count} letter${
                    count === 1 ? "" : "s"
                } (${directionLabel})</div>
                    <div class="map-tooltip-hint">Click to filter letter list</div>
                </div>`,
                { sticky: true, direction: "top" }
            );

            arcLine.on("click", function (ev) {
                L.DomEvent.stopPropagation(ev);
                toggleRouteSelection(route.routeKey);
            });

            arcLine.on("mouseover", function () {
                arcLine.setStyle({ weight: weight + 2, opacity: 1 });
                haloLine.setStyle({ opacity: 0.3 });
            });
            arcLine.on("mouseout", function () {
                arcLine.setStyle({
                    weight: weight,
                    opacity:
                        state.selectedRouteKey &&
                        state.selectedRouteKey !== route.routeKey
                            ? 0.42
                            : 0.92,
                });
                haloLine.setStyle({ opacity: isSelected ? 0.28 : 0.12 });
            });

            // Directional arrowhead + count pill along the curve midpoint
            const arrowIcon = L.divIcon({
                className: "curve-midpoint-icon",
                html: `<div class="curve-badge ${
                    route.direction === "OUT"
                        ? "curve-badge-out"
                        : "curve-badge-in"
                } ${isSelected ? "curve-badge-selected" : ""}" title="${directionLabel}">
                    <span class="curve-arrow" style="transform: rotate(${curve.angleDeg.toFixed(
                        1
                    )}deg);">&#10148;</span>
                    <span class="curve-count">${count}</span>
                </div>`,
                iconSize: [44, 22],
                iconAnchor: [22, 11],
            });

            const midMarker = L.marker(curve.midpoint, {
                icon: arrowIcon,
            }).addTo(arcsLayerGroup);

            midMarker.on("click", function (ev) {
                L.DomEvent.stopPropagation(ev);
                toggleRouteSelection(route.routeKey);
            });
        }

        // 3. Draw Connected Place Dots
        for (const [, info] of connectedPlacesMap.entries()) {
            const p = info.place;
            const totalVisible = info.outCount + info.inCount;
            const isBi = info.outCount > 0 && info.inCount > 0;
            const dotColor = isBi
                ? COLORS.bidirectional
                : info.outCount > 0
                ? COLORS.outbound
                : COLORS.inbound;

            const radius = Math.min(13, 6.5 + Math.log2(totalVisible + 1) * 1.5);

            // Outer ring for connected place
            L.circleMarker([p.lat, p.lng], {
                radius: radius + 4,
                color: dotColor,
                weight: 1.5,
                opacity: 0.35,
                fillColor: dotColor,
                fillOpacity: 0.14,
                interactive: false,
            }).addTo(markersLayerGroup);

            // Main connected place dot
            const marker = L.circleMarker([p.lat, p.lng], {
                radius: radius,
                color: "#ffffff",
                weight: 2.5,
                fillColor: dotColor,
                fillOpacity: 1,
            }).addTo(markersLayerGroup);

            const pills = [];
            if (info.outCount > 0) {
                pills.push(
                    `<span class="place-pill place-pill-out" title="Letters from ${primaryPlace.name} to ${p.name}">&nearr; ${info.outCount}</span>`
                );
            }
            if (info.inCount > 0) {
                pills.push(
                    `<span class="place-pill place-pill-in" title="Letters from ${p.name} to ${primaryPlace.name}">&swarr; ${info.inCount}</span>`
                );
            }

            marker.bindTooltip(
                `<div class="place-label-card">
                    <span class="place-label-name">${p.name}</span>
                    <span class="place-label-pills">${pills.join("")}</span>
                </div>`,
                {
                    permanent: true,
                    direction: p.lat >= primaryPlace.lat ? "top" : "bottom",
                    offset: [0, p.lat >= primaryPlace.lat ? -10 : 10],
                    className: "place-permanent-tooltip",
                }
            );

            marker.on("click", function (ev) {
                L.DomEvent.stopPropagation(ev);
                // If only one route connects this place, select it; otherwise toggle between its routes
                if (info.routes.length === 1) {
                    toggleRouteSelection(info.routes[0].routeKey);
                } else if (info.routes.length > 1) {
                    const currentIdx = info.routes.findIndex(
                        (r) => r.routeKey === state.selectedRouteKey
                    );
                    const nextRoute =
                        info.routes[(currentIdx + 1) % info.routes.length];
                    toggleRouteSelection(nextRoute.routeKey);
                }
            });
        }

        // 4. Draw Highlighted Primary Place Dot (e.g. Rouen) on top
        // Outer pulse halo
        L.circleMarker(primaryLatLng, {
            radius: 22,
            color: COLORS.primary,
            weight: 2,
            opacity: 0.45,
            fillColor: COLORS.primary,
            fillOpacity: 0.16,
            interactive: false,
        }).addTo(markersLayerGroup);

        // Middle ring
        L.circleMarker(primaryLatLng, {
            radius: 14,
            color: COLORS.primary,
            weight: 2,
            opacity: 0.75,
            fillColor: "#ffffff",
            fillOpacity: 0.9,
            interactive: false,
        }).addTo(markersLayerGroup);

        // Core crimson dot (matching `map-editor.js` `#cd3238` marker)
        const primaryMarker = L.circleMarker(primaryLatLng, {
            radius: 9.5,
            color: "#ffffff",
            weight: 2.5,
            fillColor: COLORS.primary,
            fillOpacity: 1,
        }).addTo(markersLayerGroup);

        const outTotal = network.outboundLetters.length;
        const inTotal = network.inboundLetters.length;

        primaryMarker.bindTooltip(
            `<div class="place-label-card place-label-primary">
                <span class="primary-star">&#9733;</span>
                <span class="place-label-name">${primaryPlace.name}</span>
                <span class="place-label-pills">
                    ${
                        state.showOutbound
                            ? `<span class="place-pill place-pill-out">From: ${outTotal}</span>`
                            : ""
                    }
                    ${
                        state.showInbound
                            ? `<span class="place-pill place-pill-in">To: ${inTotal}</span>`
                            : ""
                    }
                </span>
            </div>`,
            {
                permanent: true,
                direction: "bottom",
                offset: [0, 14],
                className: "place-permanent-tooltip primary-permanent-tooltip",
            }
        );

        primaryMarker.on("click", function (ev) {
            L.DomEvent.stopPropagation(ev);
            state.selectedRouteKey = null;
            renderAll(false);
        });

        if (fitView) {
            if (boundsPoints.length > 1) {
                map.fitBounds(L.latLngBounds(boundsPoints), {
                    padding: [75, 75],
                    maxZoom: 9,
                });
            } else {
                map.setView(primaryLatLng, 8);
            }
        }
    }

    function toggleRouteSelection(routeKey) {
        if (state.selectedRouteKey === routeKey) {
            state.selectedRouteKey = null;
        } else {
            state.selectedRouteKey = routeKey;
        }
        renderAll(false);
    }

    // --- Sidebar UI Rendering ---
    function renderSidebar(network) {
        const primaryPlace = DATA.places[state.selectedPlaceId];
        if (!primaryPlace) return;

        // Update header summary & At a Glance metadata
        document.getElementById("primary-place-title").textContent =
            primaryPlace.name;
        document.getElementById("primary-place-meta").textContent = `${
            primaryPlace.region ? primaryPlace.region + " · " : ""
        }${primaryPlace.country_code || ""} · TGN: ${
            primaryPlace.tgn_id || "N/A"
        } · (${primaryPlace.lat.toFixed(4)}, ${primaryPlace.lng.toFixed(4)})`;

        const setElText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setElText("meta-region", primaryPlace.region || "—");
        setElText("meta-country", primaryPlace.country_code || "—");
        setElText(
            "meta-coords",
            `${primaryPlace.lat.toFixed(4)}° N, ${primaryPlace.lng.toFixed(4)}° E`
        );
        setElText("meta-tgn", primaryPlace.tgn_id || "—");
        const tgnLink = document.getElementById("sources-tgn-link");
        if (tgnLink && primaryPlace.tgn_id) {
            tgnLink.textContent = primaryPlace.tgn_id;
            tgnLink.href = `http://vocab.getty.edu/page/tgn/${primaryPlace.tgn_id}`;
        }
        setElText("sources-label-preferred", primaryPlace.name);

        // Connected unique places count & active year range
        const uniqueConnectedIds = new Set([
            ...network.outboundRoutes.map((r) => r.otherPlaceId),
            ...network.inboundRoutes.map((r) => r.otherPlaceId),
        ]);
        const allYears = [
            ...network.outboundLetters,
            ...network.inboundLetters,
        ]
            .map((l) => l.year)
            .filter(Boolean);
        const yearRange =
            allYears.length > 0
                ? `${Math.min(...allYears)}–${Math.max(...allYears)}`
                : "—";

        setElText("stat-from-count", network.outboundLetters.length);
        setElText("stat-to-count", network.inboundLetters.length);
        setElText("stat-connected-places", uniqueConnectedIds.size);
        setElText("stat-active-range", yearRange);

        setElText(
            "preset-both",
            `ALL DIRECTIONS (${
                network.outboundLetters.length + network.inboundLetters.length
            })`
        );
        setElText(
            "preset-from",
            `FROM ${primaryPlace.name.toUpperCase()} (${
                network.outboundLetters.length
            })`
        );
        setElText(
            "preset-to",
            `TO ${primaryPlace.name.toUpperCase()} (${
                network.inboundLetters.length
            })`
        );

        // Update counts on From / To toggle cards
        const outPlottedCount = network.outboundRoutes.reduce(
            (acc, r) => acc + r.letters.length,
            0
        );
        const inPlottedCount = network.inboundRoutes.reduce(
            (acc, r) => acc + r.letters.length,
            0
        );

        document.getElementById("count-from-total").textContent =
            network.outboundLetters.length;
        document.getElementById("count-from-sub").textContent =
            network.unplacedOutbound.length > 0
                ? `${outPlottedCount} with destination place · ${network.unplacedOutbound.length} unspecified`
                : `${outPlottedCount} plotted on map`;

        document.getElementById("count-to-total").textContent =
            network.inboundLetters.length;
        document.getElementById("count-to-sub").textContent =
            network.unplacedInbound.length > 0
                ? `${inPlottedCount} with origin place · ${network.unplacedInbound.length} unspecified`
                : `${inPlottedCount} plotted on map`;

        // Show/hide Rouen-specific data note
        const rouenNote = document.getElementById("rouen-ux-options");
        if (rouenNote) {
            rouenNote.style.display =
                state.selectedPlaceId === "letters.place:448" ? "block" : "none";
        }

        // Render Route Breakdown List
        const routesContainer = document.getElementById("routes-list");
        const routeItemsHtml = [];

        if (state.showOutbound) {
            for (const r of network.outboundRoutes) {
                const isSelected = state.selectedRouteKey === r.routeKey;
                routeItemsHtml.push(`
                    <button type="button" class="route-item ${
                        isSelected ? "route-item-active" : ""
                    }" data-route-key="${r.routeKey}">
                        <span class="route-badge route-badge-out">FROM</span>
                        <span class="route-names">
                            <strong>${primaryPlace.name}</strong>
                            <span class="route-arrow">&rarr;</span>
                            <strong>${r.otherPlace.name}</strong>
                            ${
                                r.inferredCount > 0
                                    ? `<span class="inferred-tag" title="Includes ${r.inferredCount} letters inferred from recipient Alice Hoschedé">(${r.inferredCount} inferred)</span>`
                                    : ""
                            }
                        </span>
                        <span class="route-count">${r.letters.length}</span>
                    </button>
                `);
            }
            if (network.unplacedOutbound.length > 0) {
                const isSelected = state.selectedRouteKey === "UNPLACED_OUT";
                routeItemsHtml.push(`
                    <button type="button" class="route-item route-item-unplaced ${
                        isSelected ? "route-item-active" : ""
                    }" data-route-key="UNPLACED_OUT">
                        <span class="route-badge route-badge-unplaced">FROM</span>
                        <span class="route-names">
                            <strong>${primaryPlace.name}</strong>
                            <span class="route-arrow">&rarr;</span>
                            <em>Destination place not set</em>
                        </span>
                        <span class="route-count">${
                            network.unplacedOutbound.length
                        }</span>
                    </button>
                `);
            }
        }

        if (state.showInbound) {
            for (const r of network.inboundRoutes) {
                const isSelected = state.selectedRouteKey === r.routeKey;
                routeItemsHtml.push(`
                    <button type="button" class="route-item ${
                        isSelected ? "route-item-active" : ""
                    }" data-route-key="${r.routeKey}">
                        <span class="route-badge route-badge-in">TO</span>
                        <span class="route-names">
                            <strong>${r.otherPlace.name}</strong>
                            <span class="route-arrow">&rarr;</span>
                            <strong>${primaryPlace.name}</strong>
                        </span>
                        <span class="route-count">${r.letters.length}</span>
                    </button>
                `);
            }
        }

        if (routeItemsHtml.length === 0) {
            routesContainer.innerHTML = `<div class="empty-state">Turn on "Letters From" or "Letters To" above to view correspondence routes.</div>`;
        } else {
            routesContainer.innerHTML = routeItemsHtml.join("");
            routesContainer
                .querySelectorAll(".route-item")
                .forEach((btn) => {
                    btn.addEventListener("click", () => {
                        toggleRouteSelection(
                            btn.getAttribute("data-route-key")
                        );
                    });
                });
        }

        // Render Filtered Letters List
        renderLettersList(network, primaryPlace);

        // Render Typesense Query Panel
        renderTypesenseQueryPanel(primaryPlace);
    }

    function renderLettersList(network, primaryPlace) {
        const listEl = document.getElementById("letters-list");
        const filterLabelEl = document.getElementById("letters-filter-label");
        const clearBtn = document.getElementById("clear-route-filter-btn");

        let displayedLetters = [];
        let filterTitle = "All Visible Letters";

        if (state.selectedRouteKey) {
            clearBtn.style.display = "inline-flex";
            if (state.selectedRouteKey === "UNPLACED_OUT") {
                displayedLetters = network.unplacedOutbound;
                filterTitle = `From ${primaryPlace.name} (Destination Unspecified)`;
            } else {
                const allRoutes = [
                    ...network.outboundRoutes,
                    ...network.inboundRoutes,
                ];
                const match = allRoutes.find(
                    (r) => r.routeKey === state.selectedRouteKey
                );
                if (match) {
                    displayedLetters = match.letters;
                    filterTitle =
                        match.direction === "OUT"
                            ? `${primaryPlace.name} → ${match.otherPlace.name}`
                            : `${match.otherPlace.name} → ${primaryPlace.name}`;
                }
            }
        } else {
            clearBtn.style.display = "none";
            if (state.showOutbound) {
                displayedLetters.push(...network.outboundLetters);
            }
            if (state.showInbound) {
                for (const l of network.inboundLetters) {
                    if (!displayedLetters.some((existing) => existing.id === l.id)) {
                        displayedLetters.push(l);
                    }
                }
            }
        }

        filterLabelEl.textContent = `${filterTitle} (${displayedLetters.length})`;

        if (displayedLetters.length === 0) {
            listEl.innerHTML = `<div class="empty-state">No letters match the active filter toggles.</div>`;
            return;
        }

        const sorted = [...displayedLetters].sort((a, b) => {
            const da = a.date_str || "9999";
            const db = b.date_str || "9999";
            return da.localeCompare(db);
        });

        listEl.innerHTML = sorted
            .map((l) => {
                const isOutbound = l.from_place_id === primaryPlace.id;
                const dirClass = isOutbound ? "letter-card-out" : "letter-card-in";
                const dirBadge = isOutbound ? "FROM" : "TO";
                const sender = (l.written_by || []).join(", ") || "Unknown sender";
                const recipient =
                    (l.written_to || []).join(", ") || "Unknown recipient";
                const fromLabel = l.from_place_label || "Unspecified";
                const toLabel = l.to_place_label || "Unspecified destination";

                return `
                    <article class="letter-card ${dirClass}">
                        <div class="letter-card-header">
                            <span class="letter-dir-pill ${
                                isOutbound ? "pill-out" : "pill-in"
                            }">${dirBadge}</span>
                            <span class="letter-id">Letter #${
                                l.identifier
                            }</span>
                            ${
                                l.w_id
                                    ? `<span class="letter-wid">W. ${l.w_id}</span>`
                                    : ""
                            }
                            ${
                                l.is_stub
                                    ? `<span class="letter-stub-badge" title="Stub record in PostgreSQL (is_stub=True)">DB Stub</span>`
                                    : ""
                            }
                            <span class="letter-date">${
                                l.date_str || "Undated"
                            }</span>
                        </div>
                        <div class="letter-correspondents">
                            <strong>${sender}</strong> &rarr; <strong>${recipient}</strong>
                        </div>
                        <div class="letter-places">
                            <span>${fromLabel}</span> &rarr; <span>${toLabel}</span>
                        </div>
                        ${
                            l.subject
                                ? `<p class="letter-subject">${l.subject}</p>`
                                : ""
                        }
                    </article>
                `;
            })
            .join("");
    }

    function renderTypesenseQueryPanel(primaryPlace) {
        const queryPre = document.getElementById("ts-query-code");
        if (!queryPre) return;

        const params = buildTypesenseQueryParams(
            primaryPlace.id,
            state.showOutbound,
            state.showInbound
        );

        const formatted = [
            `GET http://monet-letters.localhost/_typesense/collections/letters/documents/search`,
            `Headers: { "X-TYPESENSE-API-KEY": "xyz" }`,
            ``,
            `Query Parameters:`,
            `  q                   = "${params.q}"`,
            `  filter_by           = ${params.filter_by}`,
            `  facet_by            = "${params.facet_by}"`,
            `  facet_return_parent = "${params.facet_return_parent}"`,
            `  max_facet_values    = ${params.max_facet_values}`,
            `  per_page            = ${params.per_page}`,
        ].join("\n");

        queryPre.textContent = formatted;
    }

    function updateQuickPresetButtons() {
        const btnBoth = document.getElementById("preset-both");
        const btnFrom = document.getElementById("preset-from");
        const btnTo = document.getElementById("preset-to");
        if (!btnBoth || !btnFrom || !btnTo) return;

        btnBoth.classList.toggle(
            "preset-active",
            state.showOutbound && state.showInbound
        );
        btnFrom.classList.toggle(
            "preset-active",
            state.showOutbound && !state.showInbound
        );
        btnTo.classList.toggle(
            "preset-active",
            !state.showOutbound && state.showInbound
        );

        document.getElementById("toggle-outbound").checked = state.showOutbound;
        document.getElementById("toggle-inbound").checked = state.showInbound;
    }

    function renderAll(fitView = false) {
        updateQuickPresetButtons();
        const network = computePlaceNetwork(state.selectedPlaceId);
        renderMap(network, fitView);
        renderSidebar(network);
    }

    // --- Populate Place Selector & Bind Controls ---
    function initControls() {
        const selectEl = document.getElementById("place-select");
        const placesList = Object.values(DATA.places).sort((a, b) => {
            if (a.id === "letters.place:448") return -1;
            if (b.id === "letters.place:448") return 1;
            const totalA =
                (a.db_sent_from_count || 0) + (a.db_sent_to_count || 0);
            const totalB =
                (b.db_sent_from_count || 0) + (b.db_sent_to_count || 0);
            return totalB - totalA;
        });

        selectEl.innerHTML = placesList
            .map(
                (p) =>
                    `<option value="${p.id}" ${
                        p.id === state.selectedPlaceId ? "selected" : ""
                    }>${p.name} (${p.db_sent_from_count} From · ${
                        p.db_sent_to_count
                    } To)</option>`
            )
            .join("");

        selectEl.addEventListener("change", (e) => {
            state.selectedPlaceId = e.target.value;
            state.selectedRouteKey = null;
            state.liveStatusPlaceId = state.selectedPlaceId;
            tryLiveTypesenseQuery(state.selectedPlaceId);
            renderAll(true);
        });

        // Direction checkboxes
        document
            .getElementById("toggle-outbound")
            .addEventListener("change", (e) => {
                state.showOutbound = e.target.checked;
                state.selectedRouteKey = null;
                renderAll(false);
            });

        document
            .getElementById("toggle-inbound")
            .addEventListener("change", (e) => {
                state.showInbound = e.target.checked;
                state.selectedRouteKey = null;
                renderAll(false);
            });

        // Quick preset buttons
        document.getElementById("preset-both").addEventListener("click", () => {
            state.showOutbound = true;
            state.showInbound = true;
            state.selectedRouteKey = null;
            renderAll(false);
        });

        document.getElementById("preset-from").addEventListener("click", () => {
            state.showOutbound = true;
            state.showInbound = false;
            state.selectedRouteKey = null;
            renderAll(false);
        });

        document.getElementById("preset-to").addEventListener("click", () => {
            state.showOutbound = false;
            state.showInbound = true;
            state.selectedRouteKey = null;
            renderAll(false);
        });

        // UX Toggles
        const stubToggle = document.getElementById("toggle-db-stubs");
        if (stubToggle) {
            stubToggle.checked = state.includeDbStubs;
            stubToggle.addEventListener("change", (e) => {
                state.includeDbStubs = e.target.checked;
                renderAll(false);
            });
        }

        const inferToggle = document.getElementById("toggle-infer-giverny");
        if (inferToggle) {
            inferToggle.checked = state.inferUnplacedGiverny;
            inferToggle.addEventListener("change", (e) => {
                state.inferUnplacedGiverny = e.target.checked;
                renderAll(false);
            });
        }

        const animateToggle = document.getElementById("toggle-animate-flow");
        if (animateToggle) {
            animateToggle.checked = state.animateFlow;
            animateToggle.addEventListener("change", (e) => {
                state.animateFlow = e.target.checked;
                renderAll(false);
            });
        }

        document
            .getElementById("clear-route-filter-btn")
            .addEventListener("click", () => {
                state.selectedRouteKey = null;
                renderAll(false);
            });

        document
            .getElementById("fit-bounds-btn")
            .addEventListener("click", () => {
                renderAll(true);
            });

        map.on("click", () => {
            if (state.selectedRouteKey) {
                state.selectedRouteKey = null;
                renderAll(false);
            }
        });
    }

    initControls();
    state.liveStatusPlaceId = state.selectedPlaceId;
    renderAll(true);
    tryLiveTypesenseQuery(state.selectedPlaceId);
})();
