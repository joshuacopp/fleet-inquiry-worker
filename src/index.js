// Fleet Inquiry Worker
// - Surfaces form for fleet pricing inquiries
// - Uses pricing_simple table for location/package data
// - Google Maps API for nearest location search (when key is configured)
// - Writes submissions to fleet_submissions table

const TABLE_LOCATIONS = "pricing_simple";
const TABLE_PACKAGES = "pricing_simple_resolved";
const CACHE_TTL = 300;
const STALE_TTL = 86400;

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");

  // CORS headers for API routes
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  // API: Find nearest locations
  if (path === "api/find-locations" && request.method === "POST") {
    return handleFindLocations(request, env, ctx);
  }

  // API: Get packages for a location
  if (path === "api/fleet-packages" && request.method === "POST") {
    return handleFleetPackages(request, env, ctx);
  }

  // API: Submit fleet inquiry
  if (path === "api/fleet-submit" && request.method === "POST") {
    return handleFleetSubmit(request, env, ctx);
  }

  // Main fleet form page
  if (path === "fleet" || path === "") {
    return new Response(renderFleetForm(), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  return new Response("Not found", { status: 404 });
}

/* ===================== API Handlers ===================== */

async function handleFindLocations(request, env, ctx) {
  try {
    const { address } = await request.json();
    if (!address || address.trim().length < 3) {
      return jsonResponse(400, { error: "Please enter a valid address or zip code." });
    }

    // Verify env vars are configured
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      console.error("Missing env vars: SUPABASE_URL or SUPABASE_ANON_KEY not bound");
      return jsonResponse(500, { error: "Server configuration error. Please contact support." });
    }

    const locations = await getAllLocations(env, ctx);

    if (locations.length === 0) {
      console.error("getAllLocations returned 0 locations - check Supabase connection and RLS policies on pricing_simple");
      return jsonResponse(500, { error: "Unable to load locations. Please try again later." });
    }

    // If Google Maps API key is configured, geocode and find nearest
    if (env.GOOGLE_MAPS_API_KEY) {
      const userCoords = await geocodeAddress(address, env.GOOGLE_MAPS_API_KEY);
      if (!userCoords) {
        return jsonResponse(400, { error: "Could not find that address. Please try again." });
      }

      // Geocode all locations and calculate distances
      const locationsWithDistance = await Promise.all(
        locations.map(async (loc) => {
          const locCoords = await geocodeAddress(loc.address, env.GOOGLE_MAPS_API_KEY);
          if (!locCoords) return { ...loc, distance: Infinity };
          const distance = haversineDistance(userCoords, locCoords);
          return { ...loc, distance };
        })
      );

      // Sort by distance and return nearest 5
      locationsWithDistance.sort((a, b) => a.distance - b.distance);
      const nearest = locationsWithDistance.slice(0, 5).map(loc => ({
        location_code: loc.location_code,
        location_pretty: loc.location_pretty,
        address: loc.address,
        distance: loc.distance === Infinity ? null : Math.round(loc.distance * 10) / 10,
        has_full_service: loc.has_full_service
      }));

      return jsonResponse(200, { locations: nearest, geocoded: true });
    }

    // Fallback: return all locations sorted alphabetically (no Maps API key)
    const allLocs = locations
      .sort((a, b) => a.location_pretty.localeCompare(b.location_pretty))
      .map(loc => ({
        location_code: loc.location_code,
        location_pretty: loc.location_pretty,
        address: loc.address,
        distance: null,
        has_full_service: loc.has_full_service
      }));

    return jsonResponse(200, { locations: allLocs, geocoded: false });

  } catch (error) {
    console.error("handleFindLocations error:", error);
    return jsonResponse(500, { error: "Server error. Please try again." });
  }
}

async function handleFleetPackages(request, env, ctx) {
  try {
    const { location_code, service_type } = await request.json();
    if (!location_code || !service_type) {
      return jsonResponse(400, { error: "Missing location or service type." });
    }

    const allData = await getCachedPackageData(env, ctx);
    let packages = allData.filter(r =>
      (r.location_code || "").toLowerCase() === location_code.toLowerCase()
    );

    // Filter by service type
    if (service_type === "express_exterior") {
      packages = packages.filter(r => {
        const pkg = (r.pkg || "").toLowerCase();
        return !pkg.includes("fs") && !pkg.includes("detail");
      });
    } else if (service_type === "full_service") {
      packages = packages.filter(r => {
        const pkg = (r.pkg || "").toLowerCase();
        return pkg.includes("fs");
      });
    } else if (service_type === "professional_detailing") {
      return jsonResponse(200, { packages: [], detailing: true });
    }

    // Sort by sort column
    packages.sort((a, b) => (Number(a.sort) || 99) - (Number(b.sort) || 99));

    const result = packages.map(r => ({
      pkg: r.pkg,
      pretty_pkg: r.pretty_pkg || r.pkg
    }));

    return jsonResponse(200, { packages: result, detailing: false });

  } catch (error) {
    console.error("handleFleetPackages error:", error);
    return jsonResponse(500, { error: "Server error." });
  }
}

async function handleFleetSubmit(request, env, ctx) {
  try {
    const data = await request.json();

    // Validate required fields
    const required = ["company", "name", "phone", "email", "location_code", "service_type"];
    for (const field of required) {
      if (!data[field] || data[field].trim().length === 0) {
        return jsonResponse(400, { error: `Missing required field: ${field}` });
      }
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return jsonResponse(400, { error: "Please enter a valid email address." });
    }

    const ipAddress = request.headers.get("CF-Connecting-IP") || "Unknown";
    const userAgent = request.headers.get("User-Agent") || "Unknown";

    const submission = {
      company: data.company.trim(),
      name: data.name.trim(),
      phone: data.phone.trim(),
      email: data.email.trim(),
      address: (data.address || "").trim(),
      location_code: data.location_code,
      location_pretty: data.location_pretty || data.location_code,
      service_type: data.service_type,
      packages: data.packages || null,
      submitted_at: new Date().toISOString(),
      ip_address: ipAddress,
      user_agent: userAgent,
      status: "new"
    };

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/fleet_submissions`, {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(submission)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Supabase insert error:", response.status, errorText);
      return jsonResponse(500, { error: "Failed to submit. Please try again." });
    }

    return jsonResponse(200, { success: true });

  } catch (error) {
    console.error("handleFleetSubmit error:", error);
    return jsonResponse(500, { error: "Server error. Please try again." });
  }
}

/* ===================== Data Helpers ===================== */

async function getAllLocations(env, ctx) {
  const allData = await getCachedPricingData(env, ctx);

  // Build unique locations with full_service flag
  const locationMap = new Map();
  for (const row of allData) {
    const code = (row.location_code || "").toLowerCase();
    if (!code) continue;

    if (!locationMap.has(code)) {
      locationMap.set(code, {
        location_code: code,
        location_pretty: row.location_pretty || code,
        address: row.address || "",
        has_full_service: false
      });
    }

    // Check if any package contains "fs" (full service)
    const pkg = (row.pkg || "").toLowerCase();
    if (pkg.includes("fs")) {
      locationMap.get(code).has_full_service = true;
    }
  }

  return Array.from(locationMap.values());
}

async function getCachedPricingData(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://internal-cache/fleet_location_data");
  const cached = await cache.match(cacheKey);

  if (cached) {
    const cacheAge = Date.now() - new Date(cached.headers.get("date")).getTime();
    if (cacheAge < CACHE_TTL * 1000) {
      return await cached.json();
    }
    if (cacheAge < STALE_TTL * 1000) {
      ctx.waitUntil(fetchAndCacheData(env, cache, cacheKey, TABLE_LOCATIONS, "location_pretty,location_code,pkg,single,address,sort", null));
      return await cached.json();
    }
  }
  return await fetchAndCacheData(env, cache, cacheKey, TABLE_LOCATIONS, "location_pretty,location_code,pkg,single,address,sort", cached);
}

async function getCachedPackageData(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://internal-cache/fleet_package_data");
  const cached = await cache.match(cacheKey);

  if (cached) {
    const cacheAge = Date.now() - new Date(cached.headers.get("date")).getTime();
    if (cacheAge < CACHE_TTL * 1000) {
      return await cached.json();
    }
    if (cacheAge < STALE_TTL * 1000) {
      ctx.waitUntil(fetchAndCacheData(env, cache, cacheKey, TABLE_PACKAGES, "location_code,pkg,pretty_pkg,sort", null));
      return await cached.json();
    }
  }
  return await fetchAndCacheData(env, cache, cacheKey, TABLE_PACKAGES, "location_code,pkg,pretty_pkg,sort", cached);
}

async function fetchAndCacheData(env, cache, cacheKey, table, select, fallback) {
  try {
    const u = new URL(env.SUPABASE_URL);
    u.pathname = `/rest/v1/${table}`;
    u.search = new URLSearchParams({ select }).toString();

    const r = await fetch(u.toString(), {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
    });

    if (!r.ok) {
      const errBody = await r.text();
      console.error("Supabase error:", r.status, errBody);
      throw new Error(`Supabase error: ${r.status} - ${errBody}`);
    }

    const data = await r.json();
    console.log("Supabase returned", data.length, "rows from", table);
    const cacheResponse = new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "date": new Date().toUTCString()
      }
    });

    await cache.put(cacheKey, cacheResponse);
    return data;

  } catch (error) {
    console.error("Supabase fetch failed for", table, ":", error);
    if (fallback) return await fallback.json();
    return [];
  }
}

/* ===================== Google Maps Helpers ===================== */

async function geocodeAddress(address, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === "OK" && data.results.length > 0) {
      const { lat, lng } = data.results[0].geometry.location;
      return { lat, lng };
    }
    return null;
  } catch (error) {
    console.error("Geocoding error:", error);
    return null;
  }
}

function haversineDistance(coord1, coord2) {
  const R = 3959; // Earth radius in miles
  const dLat = toRad(coord2.lat - coord1.lat);
  const dLng = toRad(coord2.lng - coord1.lng);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(coord1.lat)) * Math.cos(toRad(coord2.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

/* ===================== Response Helpers ===================== */

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/* ===================== Render Fleet Form ===================== */

function renderFleetForm() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
    <title>Splash Car Wash - Fleet Pricing Inquiry</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html {
            overflow: hidden;
            height: 100%;
            width: 100%;
            position: fixed;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%);
            height: 100%;
            width: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
            position: fixed;
        }

        .scroll-wrapper {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            overflow-y: auto;
            overflow-x: hidden;
            -webkit-overflow-scrolling: touch;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: flex-start;
        }

        /* Bubble animations */
        .bubble {
            position: absolute;
            bottom: -100px;
            background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.3));
            border-radius: 50%;
            opacity: 0.6;
            animation: rise linear infinite;
            box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.5),
                        0 0 20px rgba(255, 255, 255, 0.3);
            pointer-events: none;
            z-index: 1;
        }

        .bubble::before {
            content: '';
            position: absolute;
            top: 10%;
            left: 10%;
            width: 40%;
            height: 40%;
            background: radial-gradient(circle, rgba(255, 255, 255, 0.9), transparent);
            border-radius: 50%;
        }

        @keyframes rise {
            0% {
                bottom: -100px;
                transform: translateX(0) scale(1);
            }
            50% {
                transform: translateX(100px) scale(1.1);
            }
            100% {
                bottom: 110vh;
                transform: translateX(-100px) scale(0.8);
            }
        }

        .bubble:nth-child(1) { left: 10%; width: 60px; height: 60px; animation-duration: 8s; animation-delay: 0s; }
        .bubble:nth-child(2) { left: 20%; width: 40px; height: 40px; animation-duration: 6s; animation-delay: 1s; }
        .bubble:nth-child(3) { left: 35%; width: 80px; height: 80px; animation-duration: 10s; animation-delay: 2s; }
        .bubble:nth-child(4) { left: 50%; width: 50px; height: 50px; animation-duration: 7s; animation-delay: 0.5s; }
        .bubble:nth-child(5) { left: 65%; width: 70px; height: 70px; animation-duration: 9s; animation-delay: 1.5s; }
        .bubble:nth-child(6) { left: 80%; width: 45px; height: 45px; animation-duration: 6.5s; animation-delay: 0.8s; }
        .bubble:nth-child(7) { left: 15%; width: 55px; height: 55px; animation-duration: 8.5s; animation-delay: 2.5s; }
        .bubble:nth-child(8) { left: 75%; width: 35px; height: 35px; animation-duration: 7.5s; animation-delay: 1.2s; }
        .bubble:nth-child(9) { left: 40%; width: 65px; height: 65px; animation-duration: 9.5s; animation-delay: 0.3s; }
        .bubble:nth-child(10) { left: 90%; width: 50px; height: 50px; animation-duration: 8s; animation-delay: 2s; }

        .container {
            max-width: 600px;
            width: 100%;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
            position: relative;
            z-index: 10;
        }

        .header {
            background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
            padding: 30px 20px;
            text-align: center;
        }

        .logo {
            max-width: 200px;
            height: auto;
            margin-bottom: 10px;
        }

        .page-title {
            color: white;
            font-size: 22px;
            font-weight: bold;
            margin-top: 10px;
        }

        .page-subtitle {
            color: rgba(255, 255, 255, 0.85);
            font-size: 14px;
            margin-top: 6px;
        }

        .form-content {
            padding: 30px 20px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        label {
            display: block;
            font-weight: 600;
            color: #334155;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .required {
            color: #dc2626;
        }

        input[type="text"],
        input[type="tel"],
        input[type="email"],
        select {
            width: 100%;
            padding: 14px 16px;
            font-size: 16px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            transition: all 0.3s ease;
            font-family: inherit;
            background: white;
        }

        input[type="text"]:focus,
        input[type="tel"]:focus,
        input[type="email"]:focus,
        select:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        input.error,
        select.error {
            border-color: #dc2626;
        }

        .error-message {
            color: #dc2626;
            font-size: 13px;
            margin-top: 6px;
            display: none;
        }

        .error-message.show {
            display: block;
        }

        .location-search-group {
            display: flex;
            gap: 10px;
        }

        .location-search-group input {
            flex: 1;
        }

        .btn {
            padding: 14px 24px;
            font-size: 15px;
            font-weight: 600;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .btn-find {
            background: #3b82f6;
            color: white;
            white-space: nowrap;
        }

        .btn-find:hover {
            background: #2563eb;
            transform: translateY(-1px);
        }

        .btn-find:disabled {
            background: #94a3b8;
            cursor: not-allowed;
            transform: none;
        }

        .btn-submit {
            width: 100%;
            padding: 16px;
            font-size: 18px;
            font-weight: 700;
            background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 10px;
        }

        .btn-submit:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(30, 58, 138, 0.3);
        }

        .btn-submit:disabled {
            background: #94a3b8;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }

        .location-results {
            margin-top: 12px;
            display: none;
        }

        .location-results.show {
            display: block;
        }

        .location-card {
            padding: 14px 16px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            margin-bottom: 8px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .location-card:hover {
            border-color: #3b82f6;
            background: #f0f9ff;
        }

        .location-card.selected {
            border-color: #3b82f6;
            background: #eff6ff;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .location-card .loc-name {
            font-weight: 600;
            color: #1e3a8a;
            font-size: 15px;
        }

        .location-card .loc-address {
            color: #64748b;
            font-size: 13px;
            margin-top: 4px;
        }

        .location-card .loc-distance {
            color: #3b82f6;
            font-size: 12px;
            font-weight: 600;
            margin-top: 4px;
        }

        .service-section {
            display: none;
            margin-top: 20px;
        }

        .service-section.show {
            display: block;
        }

        .service-options {
            display: grid;
            grid-template-columns: 1fr;
            gap: 10px;
        }

        .service-card {
            padding: 16px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
        }

        .service-card:hover {
            border-color: #3b82f6;
            background: #f0f9ff;
        }

        .service-card.selected {
            border-color: #3b82f6;
            background: #eff6ff;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .service-card .service-name {
            font-weight: 600;
            color: #1e3a8a;
            font-size: 16px;
        }

        .service-card .service-desc {
            color: #64748b;
            font-size: 13px;
            margin-top: 4px;
        }

        .package-section {
            display: none;
            margin-top: 20px;
        }

        .package-section.show {
            display: block;
        }

        .package-checkboxes {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }

        .package-checkbox {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .package-checkbox:hover {
            border-color: #3b82f6;
            background: #f0f9ff;
        }

        .package-checkbox.checked {
            border-color: #3b82f6;
            background: #eff6ff;
        }

        .package-checkbox input[type="checkbox"] {
            width: 18px;
            height: 18px;
            accent-color: #3b82f6;
        }

        .package-checkbox label {
            margin: 0;
            font-size: 14px;
            font-weight: 500;
            color: #334155;
            cursor: pointer;
        }

        .detailing-note {
            background: #f0f9ff;
            border: 2px solid #bae6fd;
            border-radius: 8px;
            padding: 16px;
            color: #1e3a8a;
            font-size: 14px;
            line-height: 1.5;
        }

        .loading {
            text-align: center;
            color: #64748b;
            padding: 12px;
            font-size: 14px;
        }

        .success-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            z-index: 1000;
            justify-content: center;
            align-items: center;
            animation: fadeIn 0.3s ease;
        }

        .success-overlay.show {
            display: flex;
        }

        .success-modal {
            background: white;
            border-radius: 16px;
            padding: 40px 30px;
            text-align: center;
            max-width: 400px;
            width: 90%;
            animation: slideUp 0.4s ease;
        }

        .success-icon {
            font-size: 60px;
            margin-bottom: 20px;
            color: #16a34a;
        }

        .success-title {
            font-size: 24px;
            font-weight: 700;
            color: #1e3a8a;
            margin-bottom: 12px;
        }

        .success-message {
            font-size: 15px;
            color: #64748b;
            line-height: 1.6;
        }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }

        @media (max-width: 600px) {
            .location-search-group {
                flex-direction: column;
            }
            .package-checkboxes {
                grid-template-columns: 1fr;
            }
            .page-title {
                font-size: 20px;
            }
        }
    </style>
</head>
<body>
    <!-- Animated bubbles -->
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>

    <div class="scroll-wrapper">
        <div class="container">
            <div class="header">
                <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full (1) 1.png" alt="Splash Car Wash" class="logo">
                <div class="page-title">Fleet Pricing Inquiry</div>
                <div class="page-subtitle">Get a custom quote for your fleet</div>
            </div>

            <div class="form-content">
                <!-- Company Info -->
                <div class="form-group">
                    <label>Company Name <span class="required">*</span></label>
                    <input type="text" id="company" placeholder="Your company name" required>
                    <div class="error-message" id="err-company">Please enter your company name.</div>
                </div>

                <div class="form-group">
                    <label>Contact Name <span class="required">*</span></label>
                    <input type="text" id="name" placeholder="First and last name" required>
                    <div class="error-message" id="err-name">Please enter your name.</div>
                </div>

                <div class="form-group">
                    <label>Phone <span class="required">*</span></label>
                    <input type="tel" id="phone" placeholder="(203) 555-1234" required>
                    <div class="error-message" id="err-phone">Please enter a valid phone number (10 digits).</div>
                </div>

                <div class="form-group">
                    <label>Email <span class="required">*</span></label>
                    <input type="email" id="email" placeholder="you@company.com" required>
                    <div class="error-message" id="err-email">Please enter a valid email address.</div>
                </div>

                <!-- Location Search -->
                <div class="form-group">
                    <label>Find Your Nearest Location <span class="required">*</span></label>
                    <div class="location-search-group">
                        <input type="text" id="address" placeholder="Enter your address or zip code">
                        <button type="button" class="btn btn-find" id="findBtn">Find</button>
                    </div>
                    <div class="error-message" id="err-address">Please enter an address or zip code.</div>
                </div>

                <div class="location-results" id="locationResults">
                    <div class="loading" id="locationLoading">Searching for nearby locations...</div>
                    <div id="locationCards"></div>
                </div>

                <!-- Service Type Selection -->
                <div class="service-section" id="serviceSection">
                    <div class="form-group">
                        <label>Service Type <span class="required">*</span></label>
                        <div class="service-options" id="serviceOptions"></div>
                    </div>
                </div>

                <!-- Package Selection -->
                <div class="package-section" id="packageSection">
                    <div class="form-group">
                        <label>Select Package(s)</label>
                        <div id="packageContent"></div>
                    </div>
                </div>

                <!-- Submit -->
                <button type="button" class="btn-submit" id="submitBtn" disabled>Submit Inquiry</button>
            </div>
        </div>
    </div>

    <!-- Success Modal -->
    <div class="success-overlay" id="successOverlay">
        <div class="success-modal">
            <div class="success-icon">&#10003;</div>
            <div class="success-title">Inquiry Submitted!</div>
            <div class="success-message">
                Thank you for your interest in Splash Car Wash fleet services.
                A representative will contact you shortly with pricing details.
            </div>
        </div>
    </div>

    <script>
    (function() {
        // State
        var selectedLocation = null;
        var selectedService = null;
        var selectedPackages = [];
        var locationData = [];

        // Elements
        var companyInput = document.getElementById('company');
        var nameInput = document.getElementById('name');
        var phoneInput = document.getElementById('phone');
        var emailInput = document.getElementById('email');
        var addressInput = document.getElementById('address');
        var findBtn = document.getElementById('findBtn');
        var locationResults = document.getElementById('locationResults');
        var locationLoading = document.getElementById('locationLoading');
        var locationCards = document.getElementById('locationCards');
        var serviceSection = document.getElementById('serviceSection');
        var serviceOptions = document.getElementById('serviceOptions');
        var packageSection = document.getElementById('packageSection');
        var packageContent = document.getElementById('packageContent');
        var submitBtn = document.getElementById('submitBtn');
        var successOverlay = document.getElementById('successOverlay');

        // Phone formatting
        phoneInput.addEventListener('input', function() {
            var digits = this.value.replace(/\\D/g, '');
            if (digits.length > 10) digits = digits.slice(0, 10);
            if (digits.length >= 6) {
                this.value = '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
            } else if (digits.length >= 3) {
                this.value = '(' + digits.slice(0,3) + ') ' + digits.slice(3);
            } else {
                this.value = digits;
            }
            validateForm();
        });

        // Input validation listeners
        [companyInput, nameInput, emailInput].forEach(function(input) {
            input.addEventListener('input', validateForm);
            input.addEventListener('blur', validateForm);
        });

        // Find locations
        findBtn.addEventListener('click', findLocations);
        addressInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') findLocations();
        });

        function findLocations() {
            var address = addressInput.value.trim();
            if (!address) {
                showError('err-address');
                return;
            }
            hideError('err-address');

            // Reset downstream selections
            selectedLocation = null;
            selectedService = null;
            selectedPackages = [];
            serviceSection.classList.remove('show');
            packageSection.classList.remove('show');

            locationResults.classList.add('show');
            locationLoading.style.display = 'block';
            locationCards.innerHTML = '';
            findBtn.disabled = true;

            fetch('/api/find-locations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: address })
            })
            .then(function(resp) { return resp.json().then(function(data) { return { ok: resp.ok, data: data }; }); })
            .then(function(result) {
                if (!result.ok) {
                    locationCards.innerHTML = '<div class="error-message show">' + (result.data.error || 'Error finding locations.') + '</div>';
                    return;
                }

                locationData = result.data.locations;
                renderLocationCards(result.data.locations, result.data.geocoded);
            })
            .catch(function() {
                locationCards.innerHTML = '<div class="error-message show">Network error. Please try again.</div>';
            })
            .finally(function() {
                locationLoading.style.display = 'none';
                findBtn.disabled = false;
            });
        }

        function renderLocationCards(locations, geocoded) {
            if (locations.length === 0) {
                locationCards.innerHTML = '<div class="error-message show">No locations found.</div>';
                return;
            }

            locationCards.innerHTML = locations.map(function(loc, i) {
                return '<div class="location-card" data-index="' + i + '">' +
                    '<div class="loc-name">' + escHtml(loc.location_pretty) + '</div>' +
                    '<div class="loc-address">' + escHtml(loc.address) + '</div>' +
                    (loc.distance ? '<div class="loc-distance">' + loc.distance + ' miles away</div>' : '') +
                    '</div>';
            }).join('');

            // Click handlers
            locationCards.querySelectorAll('.location-card').forEach(function(card) {
                card.addEventListener('click', function() {
                    locationCards.querySelectorAll('.location-card').forEach(function(c) { c.classList.remove('selected'); });
                    this.classList.add('selected');

                    var idx = parseInt(this.getAttribute('data-index'));
                    selectedLocation = locationData[idx];
                    selectedService = null;
                    selectedPackages = [];
                    packageSection.classList.remove('show');

                    showServiceOptions(selectedLocation);
                    validateForm();
                });
            });
        }

        function showServiceOptions(location) {
            var services = [
                { id: 'express_exterior', name: 'Express Exterior', desc: 'Exterior wash packages' }
            ];

            if (location.has_full_service) {
                services.push({ id: 'full_service', name: 'Full Service', desc: 'Interior & exterior packages' });
            }

            services.push({ id: 'professional_detailing', name: 'Professional Detailing', desc: 'A representative will contact you' });

            serviceOptions.innerHTML = services.map(function(svc) {
                return '<div class="service-card" data-service="' + svc.id + '">' +
                    '<div class="service-name">' + svc.name + '</div>' +
                    '<div class="service-desc">' + svc.desc + '</div>' +
                '</div>';
            }).join('');

            serviceSection.classList.add('show');

            // Click handlers
            serviceOptions.querySelectorAll('.service-card').forEach(function(card) {
                card.addEventListener('click', function() {
                    serviceOptions.querySelectorAll('.service-card').forEach(function(c) { c.classList.remove('selected'); });
                    this.classList.add('selected');

                    selectedService = this.getAttribute('data-service');
                    selectedPackages = [];
                    loadPackages(selectedLocation.location_code, selectedService);
                    validateForm();
                });
            });
        }

        function loadPackages(locationCode, serviceType) {
            packageSection.classList.remove('show');

            if (serviceType === 'professional_detailing') {
                packageContent.innerHTML = '<div class="detailing-note">A Splash Car Wash representative will contact you to discuss professional detailing options and provide a custom quote for your fleet.</div>';
                packageSection.classList.add('show');
                validateForm();
                return;
            }

            packageContent.innerHTML = '<div class="loading">Loading packages...</div>';
            packageSection.classList.add('show');

            fetch('/api/fleet-packages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ location_code: locationCode, service_type: serviceType })
            })
            .then(function(resp) { return resp.json(); })
            .then(function(data) {
                if (!data.packages || data.packages.length === 0) {
                    packageContent.innerHTML = '<div class="detailing-note">No packages available for this service at this location.</div>';
                    return;
                }

                packageContent.innerHTML = '<div class="package-checkboxes">' +
                    data.packages.map(function(pkg, i) {
                        return '<div class="package-checkbox" data-pkg="' + escHtml(pkg.pkg) + '">' +
                            '<input type="checkbox" id="pkg-' + i + '">' +
                            '<label for="pkg-' + i + '">' + escHtml(pkg.pretty_pkg) + '</label>' +
                        '</div>';
                    }).join('') +
                    '</div>';

                // Click handlers for package checkboxes
                packageContent.querySelectorAll('.package-checkbox').forEach(function(box) {
                    box.addEventListener('click', function(e) {
                        if (e.target.tagName === 'INPUT') return;
                        var cb = this.querySelector('input[type="checkbox"]');
                        cb.checked = !cb.checked;
                        this.classList.toggle('checked', cb.checked);
                        updateSelectedPackages();
                    });

                    box.querySelector('input[type="checkbox"]').addEventListener('change', function() {
                        box.classList.toggle('checked', this.checked);
                        updateSelectedPackages();
                    });
                });
            })
            .catch(function() {
                packageContent.innerHTML = '<div class="error-message show">Error loading packages.</div>';
            });
        }

        function updateSelectedPackages() {
            selectedPackages = [];
            packageContent.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
                var box = cb.closest('.package-checkbox');
                selectedPackages.push(box.getAttribute('data-pkg'));
            });
            validateForm();
        }

        function validateForm() {
            var companyValid = companyInput.value.trim().length > 0;
            var nameValid = nameInput.value.trim().length > 0;
            var phoneDigits = phoneInput.value.replace(/\\D/g, '');
            var phoneValid = phoneDigits.length === 10;
            var emailValid = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(emailInput.value.trim());
            var locationValid = selectedLocation !== null;
            var serviceValid = selectedService !== null;

            // Show/hide errors only if field has content
            toggleError('err-company', !companyValid && companyInput.value.length > 0);
            toggleError('err-name', !nameValid && nameInput.value.length > 0);
            toggleError('err-phone', !phoneValid && phoneInput.value.length > 0);
            toggleError('err-email', !emailValid && emailInput.value.length > 0);

            var formValid = companyValid && nameValid && phoneValid && emailValid && locationValid && serviceValid;
            submitBtn.disabled = !formValid;
            return formValid;
        }

        // Submit
        submitBtn.addEventListener('click', function() {
            if (!validateForm()) return;

            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';

            var phoneDigits = phoneInput.value.replace(/\\D/g, '');

            var payload = {
                company: companyInput.value.trim(),
                name: nameInput.value.trim(),
                phone: phoneDigits,
                email: emailInput.value.trim(),
                address: addressInput.value.trim(),
                location_code: selectedLocation.location_code,
                location_pretty: selectedLocation.location_pretty,
                service_type: selectedService,
                packages: selectedService === 'professional_detailing' ? null : selectedPackages.length > 0 ? selectedPackages.join(', ') : null
            };

            fetch('/api/fleet-submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(function(resp) { return resp.json().then(function(data) { return { ok: resp.ok, data: data }; }); })
            .then(function(result) {
                if (result.ok && result.data.success) {
                    successOverlay.classList.add('show');
                } else {
                    alert(result.data.error || 'Submission failed. Please try again.');
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit Inquiry';
                }
            })
            .catch(function() {
                alert('Network error. Please try again.');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Submit Inquiry';
            });
        });

        // Helpers
        function showError(id) {
            document.getElementById(id).classList.add('show');
        }
        function hideError(id) {
            document.getElementById(id).classList.remove('show');
        }
        function toggleError(id, show) {
            var el = document.getElementById(id);
            if (el) { if (show) el.classList.add('show'); else el.classList.remove('show'); }
        }
        function escHtml(s) {
            var div = document.createElement('div');
            div.textContent = s || '';
            return div.innerHTML;
        }
    })();
    </script>
</body>
</html>`;
}