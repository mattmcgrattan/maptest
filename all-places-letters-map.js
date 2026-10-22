/**
 * All-Places Correspondence Network Map Prototype (`all-places-letters-map.js`)
 *
 * Plots ALL 24 active Places and ALL place-to-place correspondence routes simultaneously
 * using Leaflet and smooth quadratic Bézier curves (`computeQuadraticCurve`), with
 * uncluttered minimal typography (removing large multi-pill cards and midpoint badges
 * so the Bézier curves remain clean and legible).
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
        hubPrimary: "#cd3238",      // Crimson accent for major hubs / focused place
        outbound: "#19599a",        // --color-monet-link (Monet Cobalt Blue)
        inbound: "#b45309",         // Warm Ochre / Sienna (used when focusing a place or reverse pair)
        networkCurve: "#19599a",    // Default curve color in full network mode
        reverseCurve: "#b45309",    // Contrasting curve color for reverse direction of a bidirectional pair
        connectedDot: "#124574",    // --color-monet-deep-blue for places with connected routes
        singlePointDot: "#606060",  // --color-monet-text-secondary for places with only 1 endpoint specified
        boundary: "#918477",
    };

    const state = {
        labelMode: "hubs",            // "hubs" | "hover" | "all"
        showMidpointBadges: false,    // Keep false by default so Bézier curves stay uncluttered
        showDirectionChevrons: true,  // Tiny frameless directional chevron on curves
        showSingleEndpointPlaces: true, // Show places whose letters don't have the other place endpoint set
        includeDbStubs: true,         // Include the 6 DB stub letters for Rouen
        inferUnplacedGiverny: false,  // UX option: infer Giverny for Rouen -> Alice letters
        animateFlow: true,            // Subtle animated dash flow along curves
        focusedPlaceId: null,         // Optional: click a place to highlight its From/To within the full network
        focusDirection: "BOTH",       // "BOTH" | "OUT" | "IN" when a place is focused
        selectedRouteKey: null,       // Optional: "letters.place:434->letters.place:435"
        hoveredPlaceId: null,
        liveTypesenseStatus: "checking",
        liveLettersOverride: null,
    };

    // --- Initialize Leaflet Map ---
    // Start centered on Northern France / English Channel to show the main correspondence network clearly
    const map = L.map("map", {
        zoomControl: false,
        preferCanvas: false,
    }).setView([49.25, 1.35], 6);

    L.control.zoom({ position: "topright" }).addTo(map);

    // Base Tile Layers (same MapTiler Positron key as `place-letters-map.js` + OSM + Historic Rumsey)
    const cartoLight = L.tileLayer(
        "https://api.maptiler.com/maps/positron/{z}/{x}/{y}.png?key=Lq8508I7odKgD3CEFzPK",
        {
            tileSize: 512,
            zoomOffset: -1,
            attribution: "&copy; MapTiler &copy; OpenStreetMap contributors",
        }
    ).addTo(map);

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

    const arcsLayerGroup = L.layerGroup().addTo(map);
    const markersLayerGroup = L.layerGroup().addTo(map);

    L.control
        .layers(
            {
                "Editorial Light (Positron)": cartoLight,
                "Standard OpenStreetMap (Admin Default)": osmStandard,
                "19th-Century Historical Overlay (Rumsey)": historicRumsey,
            },
            {
                "Curved Correspondence Arcs": arcsLayerGroup,
                "Place Dots & Minimal Labels": markersLayerGroup,
            },
            { position: "topright", collapsed: true }
        )
        .addTo(map);

    // Re-evaluate zoom-dependent label visibility when zooming
    map.on("zoomend", () => {
        updateZoomDependentClasses();
    });

    function updateZoomDependentClasses() {
        const container = map.getContainer();
        if (!container) return;
        const z = map.getZoom();
        container.classList.toggle("map-zoom-detailed", z >= 8);
        container.classList.toggle("map-zoom-close", z >= 10);
    }

    // --- Quadratic Bézier Curved Line Geometry ---
    /**
     * Generates a smooth quadratic Bézier curve between `start` and `end`.
     * Offsets the control point to the right-hand side of the directed vector
     * (start -> end) so bidirectional routes (A -> B and B -> A) bow onto
     * opposite sides and never overlap.
     */
    function computeQuadraticCurve(
        startLatLng,
        endLatLng,
        curvature = 0.22,
        numPoints = 64
    ) {
        const lat1 = startLatLng[0];
        const lng1 = startLatLng[1];
        const lat2 = endLatLng[0];
        const lng2 = endLatLng[1];

        const midLat = (lat1 + lat2) / 2;
        const midLng = (lng1 + lng2) / 2;

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

        // Midpoint and tangent at t = 0.54 (slightly past midpoint toward destination)
        const tMid = 0.54;
        const invTMid = 1 - tMid;
        const arrowLat =
            invTMid * invTMid * lat1 +
            2 * invTMid * tMid * ctrlLat +
            tMid * tMid * lat2;
        const arrowLng =
            invTMid * invTMid * lng1 +
            2 * invTMid * tMid * ctrlLng +
            tMid * tMid * lng2;

        const dLatDt =
            2 * invTMid * (ctrlLat - lat1) + 2 * tMid * (lat2 - ctrlLat);
        const dLngDtScaled =
            (2 * invTMid * (ctrlLng - lng1) + 2 * tMid * (lng2 - ctrlLng)) *
            cosLat;
        const angleDeg = (Math.atan2(-dLatDt, dLngDtScaled) * 180) / Math.PI;

        return {
            points,
            midpoint: [arrowLat, arrowLng],
            angleDeg,
        };
    }

    // --- Dataset & Full Network Computation ---
    function getAllActiveLetters() {
        let letters = (state.liveLettersOverride || DATA.letters || []).map(
            (l) => ({ ...l })
        );

        if (state.includeDbStubs && DATA.rouen_db_stubs) {
            letters = letters.concat(
                DATA.rouen_db_stubs.map((s) => ({ ...s }))
            );
        }

        if (state.inferUnplacedGiverny) {
            letters = letters.map((l) => {
                if (
                    l.from_place_id === "letters.place:448" &&
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

    function computeFullNetwork() {
        const letters = getAllActiveLetters();
        const placesStats = new Map();

        // Initialize all known places from DATA.places
        for (const [id, p] of Object.entries(DATA.places)) {
            placesStats.set(id, {
                place: p,
                sentFromCount: 0,
                sentToCount: 0,
                connectedSentFrom: 0,
                connectedSentTo: 0,
                unplacedSentFrom: 0,
                unplacedSentTo: 0,
                connectedPlaceIds: new Set(),
                letters: [],
            });
        }

        // Directed routes map: "fromId->toId"
        const routesMap = new Map();
        const unplacedLetters = [];

        for (const l of letters) {
            const fromId =
                l.from_place_id && DATA.places[l.from_place_id]
                    ? l.from_place_id
                    : null;
            const toId =
                l.to_place_id && DATA.places[l.to_place_id]
                    ? l.to_place_id
                    : null;

            if (fromId) {
                const st = placesStats.get(fromId);
                st.sentFromCount += 1;
                st.letters.push(l);
            }
            if (toId) {
                const st = placesStats.get(toId);
                st.sentToCount += 1;
                if (toId !== fromId) {
                    st.letters.push(l);
                }
            }

            if (fromId && toId && fromId !== toId) {
                const routeKey = `${fromId}->${toId}`;
                if (!routesMap.has(routeKey)) {
                    routesMap.set(routeKey, {
                        routeKey,
                        fromPlaceId: fromId,
                        toPlaceId: toId,
                        fromPlace: DATA.places[fromId],
                        toPlace: DATA.places[toId],
                        letters: [],
                        inferredCount: 0,
                    });
                }
                const route = routesMap.get(routeKey);
                route.letters.push(l);
                if (l.inferred_destination) {
                    route.inferredCount += 1;
                }

                const fromSt = placesStats.get(fromId);
                const toSt = placesStats.get(toId);
                fromSt.connectedSentFrom += 1;
                fromSt.connectedPlaceIds.add(toId);
                toSt.connectedSentTo += 1;
                toSt.connectedPlaceIds.add(fromId);
            } else {
                if (fromId) {
                    placesStats.get(fromId).unplacedSentFrom += 1;
                }
                if (toId) {
                    placesStats.get(toId).unplacedSentTo += 1;
                }
                unplacedLetters.push(l);
            }
        }

        // Mark whether each route has a reverse counterpart (bidirectional pair)
        const routes = Array.from(routesMap.values()).sort(
            (a, b) => b.letters.length - a.letters.length
        );
        for (const r of routes) {
            const reverseKey = `${r.toPlaceId}->${r.fromPlaceId}`;
            r.hasReverse = routesMap.has(reverseKey);
            if (r.hasReverse) {
                const rev = routesMap.get(reverseKey);
                // Canonical ordering: higher letter count is primary (blue), lower is reverse (ochre)
                r.isReverseMinor =
                    r.letters.length < rev.letters.length ||
                    (r.letters.length === rev.letters.length &&
                        r.fromPlaceId > r.toPlaceId);
            } else {
                r.isReverseMinor = false;
            }
        }

        const placesArray = Array.from(placesStats.values())
            .filter((ps) => ps.sentFromCount + ps.sentToCount > 0)
            .sort(
                (a, b) =>
                    b.sentFromCount +
                    b.sentToCount -
                    (a.sentFromCount + a.sentToCount)
            );

        return {
            letters,
            routes,
            placesStats,
            placesArray,
            unplacedLetters,
        };
    }

    // Well-spaced hubs or high-volume places that get minimal permanent labels in "hubs" mode
    const MAJOR_HUB_IDS = new Set([
        "letters.place:434", // Giverny (223)
        "letters.place:435", // Paris (94)
        "letters.place:448", // Rouen (30)
        "letters.place:439", // London (23)
        "letters.place:437", // Honfleur (11)
        "letters.place:441", // Olso (9)
        "letters.place:467", // Sandviken, Bergen (6)
        "letters.place:440", // Vétheuil (6)
        "letters.place:469", // Zaandam (4)
        "letters.place:474", // Nice (1, geographically distinct in South of France)
        "letters.place:487", // Charlottenburg / Berlin (1, geographically distinct in Germany)
        "letters.place:456", // Fresselines (1, geographically distinct in Creuse)
    ]);

    function getLabelDirectionForPlace(place) {
        // Custom label directions for the Seine / Normandy cluster to prevent text collisions
        const overrides = {
            "letters.place:434": "right",  // Giverny
            "letters.place:435": "bottom", // Paris
            "letters.place:448": "top",    // Rouen
            "letters.place:437": "left",   // Honfleur
            "letters.place:438": "left",   // Sainte-Adresse
            "letters.place:468": "left",   // Étretat
            "letters.place:480": "top",    // Pourville
            "letters.place:440": "left",   // Vétheuil
            "letters.place:491": "left",   // Yainville
            "letters.place:439": "top",    // London
        };
        return overrides[place.id] || "top";
    }

    // --- Map Rendering ---
    function renderMap(network, fitMode = null) {
        arcsLayerGroup.clearLayers();
        markersLayerGroup.clearLayers();

        const activeFocusPlaceId = state.hoveredPlaceId || state.focusedPlaceId;
        const boundsPoints = [];

        // 1. Render All Quadratic Bézier Curves
        // Sort so smaller routes draw first and heaviest/selected routes draw on top
        const routesToDraw = [...network.routes].sort(
            (a, b) => a.letters.length - b.letters.length
        );

        for (const route of routesToDraw) {
            const fromLatLng = [route.fromPlace.lat, route.fromPlace.lng];
            const toLatLng = [route.toPlace.lat, route.toPlace.lng];

            // Check if filtered out by focusedPlaceId + focusDirection
            const matchesFocusedPlace =
                !activeFocusPlaceId ||
                (state.focusDirection === "BOTH" &&
                    (route.fromPlaceId === activeFocusPlaceId ||
                        route.toPlaceId === activeFocusPlaceId)) ||
                (state.focusDirection === "OUT" &&
                    route.fromPlaceId === activeFocusPlaceId) ||
                (state.focusDirection === "IN" &&
                    route.toPlaceId === activeFocusPlaceId);

            const isSelectedRoute = state.selectedRouteKey === route.routeKey;
            const isDimmed =
                (state.selectedRouteKey && !isSelectedRoute) ||
                (activeFocusPlaceId && !matchesFocusedPlace);

            // Slightly vary curvature by distance so long Europe-wide arcs don't bow excessively
            const dLat = toLatLng[0] - fromLatLng[0];
            const dLng = toLatLng[1] - fromLatLng[1];
            const degDist = Math.hypot(dLat, dLng);
            const curvature = degDist > 5 ? 0.16 : 0.23;

            const curve = computeQuadraticCurve(
                fromLatLng,
                toLatLng,
                curvature,
                64
            );

            // Determine curve color:
            // - If a place is focused/hovered: Outbound from that place = Monet Blue, Inbound to that place = Warm Ochre
            // - Otherwise in global network mode: Primary direction = Monet Blue, reverse of bidirectional pair = Warm Ochre
            let baseColor = COLORS.networkCurve;
            if (activeFocusPlaceId && matchesFocusedPlace) {
                baseColor =
                    route.fromPlaceId === activeFocusPlaceId
                        ? COLORS.outbound
                        : COLORS.inbound;
            } else if (route.isReverseMinor) {
                baseColor = COLORS.reverseCurve;
            }

            const count = route.letters.length;
            const weight = Math.min(
                7.5,
                2.0 + Math.log2(count + 1) * 1.15 + (isSelectedRoute ? 2 : 0)
            );
            const baseOpacity = isDimmed
                ? 0.14
                : isSelectedRoute
                ? 0.96
                : Math.min(0.88, 0.58 + Math.log2(count + 1) * 0.06);

            // Subtle halo under active/non-dimmed curves
            const haloLine = L.polyline(curve.points, {
                color: baseColor,
                weight: weight + 4,
                opacity: isDimmed ? 0.02 : isSelectedRoute ? 0.26 : 0.09,
                lineCap: "round",
                interactive: false,
            }).addTo(arcsLayerGroup);

            const classNames = ["correspondence-arc"];
            if (state.animateFlow && !isDimmed) {
                classNames.push("arc-animated");
            }
            if (route.inferredCount > 0 && route.inferredCount === count) {
                classNames.push("arc-inferred");
            }

            const arcLine = L.polyline(curve.points, {
                color: baseColor,
                weight: weight,
                opacity: baseOpacity,
                lineCap: "round",
                dashArray: state.animateFlow && !isDimmed ? "8, 6" : null,
                className: classNames.join(" "),
            }).addTo(arcsLayerGroup);

            arcLine.bindTooltip(
                `<div class="map-tooltip">
                    <div class="map-tooltip-title">${route.fromPlace.name} &rarr; ${
                    route.toPlace.name
                }</div>
                    <div class="map-tooltip-sub"><strong>${count}</strong> letter${
                    count === 1 ? "" : "s"
                } sent from ${route.fromPlace.name} to ${route.toPlace.name}</div>
                    <div class="map-tooltip-hint">Click curve to inspect letters</div>
                </div>`,
                { sticky: true, direction: "top" }
            );

            arcLine.on("click", function (ev) {
                L.DomEvent.stopPropagation(ev);
                toggleRouteSelection(route.routeKey);
            });

            arcLine.on("mouseover", function () {
                arcLine.setStyle({ weight: weight + 2, opacity: 1 });
                haloLine.setStyle({ opacity: 0.28 });
            });
            arcLine.on("mouseout", function () {
                arcLine.setStyle({ weight: weight, opacity: baseOpacity });
                haloLine.setStyle({
                    opacity: isDimmed ? 0.02 : isSelectedRoute ? 0.26 : 0.09,
                });
            });

            // Optional midpoint indicator:
            // By default, only a tiny frameless directional chevron (`12x12`) is shown so curves stay uncluttered.
            // Users can optionally toggle compact count pills if desired.
            if (!isDimmed && (state.showMidpointBadges || state.showDirectionChevrons)) {
                if (state.showMidpointBadges) {
                    const badgeIcon = L.divIcon({
                        className: "curve-midpoint-icon",
                        html: `<div class="curve-badge-compact" style="background:${baseColor};">
                            <span class="curve-arrow" style="transform: rotate(${curve.angleDeg.toFixed(
                                1
                            )}deg);">&#10148;</span>
                            <span>${count}</span>
                        </div>`,
                        iconSize: [34, 18],
                        iconAnchor: [17, 9],
                    });
                    const midMarker = L.marker(curve.midpoint, {
                        icon: badgeIcon,
                    }).addTo(arcsLayerGroup);
                    midMarker.on("click", function (ev) {
                        L.DomEvent.stopPropagation(ev);
                        toggleRouteSelection(route.routeKey);
                    });
                } else if (state.showDirectionChevrons) {
                    const chevronIcon = L.divIcon({
                        className: "curve-chevron-icon",
                        html: `<span class="curve-chevron" style="color:${baseColor}; transform: rotate(${curve.angleDeg.toFixed(
                            1
                        )}deg);">&#10148;</span>`,
                        iconSize: [14, 14],
                        iconAnchor: [7, 7],
                    });
                    L.marker(curve.midpoint, {
                        icon: chevronIcon,
                        interactive: false,
                    }).addTo(arcsLayerGroup);
                }
            }
        }

        // 2. Render All Active Place Dots & Minimal Labels
        for (const ps of network.placesArray) {
            const p = ps.place;
            const hasConnectedRoutes = ps.connectedPlaceIds.size > 0;
            if (!state.showSingleEndpointPlaces && !hasConnectedRoutes) {
                continue;
            }

            const latLng = [p.lat, p.lng];
            boundsPoints.push(latLng);

            const totalLetters = ps.sentFromCount + ps.sentToCount;
            const isFocused = state.focusedPlaceId === p.id;
            const isMajorHub = totalLetters >= 20 || p.id === "letters.place:448";

            // Determine whether this place is involved in the currently selected route or focused place
            let isRelatedToFocus = true;
            if (state.selectedRouteKey) {
                const [rFrom, rTo] = state.selectedRouteKey.split("->");
                isRelatedToFocus = p.id === rFrom || p.id === rTo;
            } else if (activeFocusPlaceId) {
                const focusedStats = network.placesStats.get(activeFocusPlaceId);
                isRelatedToFocus =
                    p.id === activeFocusPlaceId ||
                    (focusedStats && focusedStats.connectedPlaceIds.has(p.id));
            }

            const dotColor = isFocused
                ? COLORS.hubPrimary
                : isMajorHub
                ? COLORS.hubPrimary
                : hasConnectedRoutes
                ? COLORS.connectedDot
                : COLORS.singlePointDot;

            const radius = Math.min(
                12.5,
                4.5 + Math.log2(totalLetters + 1) * 1.15 + (isFocused ? 2 : 0)
            );

            // Subtle outer ring for major hubs or focused place
            if (isMajorHub || isFocused) {
                L.circleMarker(latLng, {
                    radius: radius + 4.5,
                    color: dotColor,
                    weight: 1.5,
                    opacity: isRelatedToFocus ? 0.45 : 0.12,
                    fillColor: dotColor,
                    fillOpacity: isRelatedToFocus ? 0.14 : 0.04,
                    interactive: false,
                }).addTo(markersLayerGroup);
            }

            const marker = L.circleMarker(latLng, {
                radius: radius,
                color: "#fefbf4",
                weight: 2,
                opacity: isRelatedToFocus ? 1 : 0.35,
                fillColor: dotColor,
                fillOpacity: isRelatedToFocus ? 0.95 : 0.3,
            }).addTo(markersLayerGroup);

            // Decide whether to show a permanent minimal text label vs hover-only tooltip
            const isMajorLabel = MAJOR_HUB_IDS.has(p.id) || isFocused;
            const showPermanentLabel =
                state.labelMode === "all" ||
                (state.labelMode === "hubs" && isMajorLabel);

            const dir = getLabelDirectionForPlace(p);
            const offsetMap = {
                top: [0, -(radius + 4)],
                bottom: [0, radius + 4],
                left: [-(radius + 6), 0],
                right: [radius + 6, 0],
            };

            if (showPermanentLabel && isRelatedToFocus) {
                // Clean, frameless typographic label (no bulky multi-pill boxes blocking curves)
                marker.bindTooltip(
                    `<span class="minimal-place-label ${
                        isMajorHub || isFocused ? "minimal-place-label-hub" : ""
                    }">${p.name}</span>`,
                    {
                        permanent: true,
                        direction: dir,
                        offset: offsetMap[dir] || [0, -8],
                        className: "minimal-permanent-tooltip",
                    }
                );
            } else {
                // Rich hover tooltip with From/To breakdown
                marker.bindTooltip(
                    `<div class="map-tooltip">
                        <div class="map-tooltip-title">${p.name}</div>
                        <div class="map-tooltip-sub">
                            <strong>${ps.sentFromCount}</strong> sent from &middot;
                            <strong>${ps.sentToCount}</strong> sent to
                            ${
                                ps.connectedPlaceIds.size > 0
                                    ? `<br/>Connected to ${ps.connectedPlaceIds.size} place${
                                          ps.connectedPlaceIds.size === 1 ? "" : "s"
                                      }`
                                    : `<br/><em>Other endpoint place unspecified</em>`
                            }
                        </div>
                        <div class="map-tooltip-hint">Click to focus ${p.name}'s routes</div>
                    </div>`,
                    {
                        permanent: false,
                        direction: "top",
                        offset: [0, -radius],
                    }
                );
            }

            marker.on("click", function (ev) {
                L.DomEvent.stopPropagation(ev);
                toggleFocusPlace(p.id);
            });
        }

        updateZoomDependentClasses();

        if (fitMode === "EUROPE" && boundsPoints.length > 1) {
            map.fitBounds(L.latLngBounds(boundsPoints), {
                padding: [50, 50],
                maxZoom: 8,
            });
        } else if (fitMode === "NORMANDY") {
            // Frame the Le Havre / Pourville / Rouen / Giverny / Paris corridor
            map.fitBounds(
                L.latLngBounds([
                    [48.78, 0.05],
                    [49.98, 2.48],
                ]),
                { padding: [40, 40] }
            );
        }
    }

    function toggleFocusPlace(placeId) {
        state.selectedRouteKey = null;
        if (state.focusedPlaceId === placeId) {
            state.focusedPlaceId = null;
        } else {
            state.focusedPlaceId = placeId;
        }
        const focusSelect = document.getElementById("focus-place-select");
        if (focusSelect) {
            focusSelect.value = state.focusedPlaceId || "";
        }
        renderAll( null);
    }

    function toggleRouteSelection(routeKey) {
        if (state.selectedRouteKey === routeKey) {
            state.selectedRouteKey = null;
        } else {
            state.selectedRouteKey = routeKey;
        }
        renderAll(null);
    }

    // --- Top Controls & Typesense Panel Rendering ---
    function renderSidebar(network) {
        // Focused Place Banner / Controls
        const focusBanner = document.getElementById("focus-place-banner");
        const focusTitle = document.getElementById("focus-place-name");
        const focusStats = document.getElementById("focus-place-stats");
        if (focusBanner) {
            if (state.focusedPlaceId && DATA.places[state.focusedPlaceId]) {
                const fp = DATA.places[state.focusedPlaceId];
                const st = network.placesStats.get(state.focusedPlaceId);
                focusBanner.style.display = "flex";
                if (focusTitle) focusTitle.textContent = fp.name;
                if (focusStats && st) {
                    focusStats.textContent = `${st.sentFromCount} From · ${st.sentToCount} To · ${st.connectedPlaceIds.size} connected places`;
                }
            } else {
                focusBanner.style.display = "none";
            }
        }

        renderTypesenseQueryPanel();
    }

    function renderTypesenseQueryPanel() {
        const queryPre = document.getElementById("ts-query-code");
        if (!queryPre) return;

        const filterClause = state.focusedPlaceId
            ? `relationships.relationship_id:=[letters.letter|letters.place|written_from_place|${state.focusedPlaceId}, letters.letter|letters.place|written_to_place|${state.focusedPlaceId}]`
            : `relationships.relationship_type:=[letters.letter|letters.place|written_from_place, letters.letter|letters.place|written_to_place]`;

        queryPre.textContent = [
            `GET http://monet-letters.localhost/_typesense/collections/letters/documents/search`,
            `Headers: { "X-TYPESENSE-API-KEY": "xyz" }`,
            ``,
            `Query Parameters (All-Places Correspondence Network):`,
            `  q                   = "*"`,
            `  filter_by           = ${filterClause}`,
            `  facet_by            = "relationships.relationship_id"`,
            `  facet_return_parent = "relationships.relationship_id"`,
            `  max_facet_values    = 500`,
            `  per_page            = 250`,
        ].join("\n");
    }

    function renderAll(fitMode = null) {
        const network = computeFullNetwork();
        renderMap(network, fitMode);
        renderSidebar(network);
    }

    // --- Bind UI Controls ---
    function initControls() {
        // Populate optional "Focus Place" selector in header
        const focusSelect = document.getElementById("focus-place-select");
        if (focusSelect) {
            const placesSorted = Object.values(DATA.places).sort((a, b) => {
                const ta = (a.db_sent_from_count || 0) + (a.db_sent_to_count || 0);
                const tb = (b.db_sent_from_count || 0) + (b.db_sent_to_count || 0);
                return tb - ta;
            });

            focusSelect.innerHTML =
                `<option value="">All 24 Places Active (Full Network)</option>` +
                placesSorted
                    .map(
                        (p) =>
                            `<option value="${p.id}">${p.name} (${p.db_sent_from_count} From · ${p.db_sent_to_count} To)</option>`
                    )
                    .join("");

            focusSelect.addEventListener("change", (e) => {
                state.focusedPlaceId = e.target.value || null;
                state.selectedRouteKey = null;
                renderAll(null);
            });
        }

        // Label density selector
        const labelModeRadios = document.querySelectorAll(
            'input[name="label-mode"]'
        );
        labelModeRadios.forEach((radio) => {
            radio.addEventListener("change", (e) => {
                if (e.target.checked) {
                    state.labelMode = e.target.value;
                    renderAll(null);
                }
            });
        });

        // Viewport preset buttons in the Monet tab bar
        const btnNormandy = document.getElementById("view-normandy-btn");
        const btnEurope = document.getElementById("view-europe-btn");
        if (btnNormandy) {
            btnNormandy.addEventListener("click", () => {
                btnNormandy.classList.add("preset-active");
                if (btnEurope) btnEurope.classList.remove("preset-active");
                renderAll("NORMANDY");
            });
        }
        if (btnEurope) {
            btnEurope.addEventListener("click", () => {
                btnEurope.classList.add("preset-active");
                if (btnNormandy) btnNormandy.classList.remove("preset-active");
                renderAll("EUROPE");
            });
        }

        // Direction filter buttons when focusing a place
        document.querySelectorAll("[data-focus-dir]").forEach((btn) => {
            btn.addEventListener("click", () => {
                state.focusDirection = btn.getAttribute("data-focus-dir");
                document
                    .querySelectorAll("[data-focus-dir]")
                    .forEach((b) =>
                        b.classList.toggle(
                            "dir-pill-active",
                            b === btn
                        )
                    );
                renderAll(null);
            });
        });

        const clearFocusBtn = document.getElementById("clear-focus-place-btn");
        if (clearFocusBtn) {
            clearFocusBtn.addEventListener("click", () => {
                state.focusedPlaceId = null;
                state.selectedRouteKey = null;
                if (focusSelect) focusSelect.value = "";
                renderAll(null);
            });
        }

        // UX Checkboxes
        const bindToggle = (id, key) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.checked = state[key];
            el.addEventListener("change", (e) => {
                state[key] = e.target.checked;
                renderAll(null);
            });
        };

        bindToggle("toggle-single-places", "showSingleEndpointPlaces");
        bindToggle("toggle-midpoint-badges", "showMidpointBadges");
        bindToggle("toggle-chevrons", "showDirectionChevrons");
        bindToggle("toggle-db-stubs", "includeDbStubs");
        bindToggle("toggle-infer-giverny", "inferUnplacedGiverny");
        bindToggle("toggle-animate-flow", "animateFlow");

        const clearRouteBtn = document.getElementById("clear-route-filter-btn");
        if (clearRouteBtn) {
            clearRouteBtn.addEventListener("click", () => {
                state.selectedRouteKey = null;
                state.focusedPlaceId = null;
                if (focusSelect) focusSelect.value = "";
                renderAll(null);
            });
        }

        map.on("click", () => {
            if (state.selectedRouteKey || state.focusedPlaceId) {
                state.selectedRouteKey = null;
                state.focusedPlaceId = null;
                if (focusSelect) focusSelect.value = "";
                renderAll(null);
            }
        });
    }

    initControls();
    // Start framed on the Normandy / Paris / Channel cluster where the curves are richest, or fit all
    renderAll("NORMANDY");
})();
