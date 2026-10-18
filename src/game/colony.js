import { SceneryReflections } from '../world/reflections.js'
import * as THREE from 'three'
import { PLANETS, createTerrain, createScatter, terrainHeight } from '../world/planet.js'
import { createWater } from '../world/water.js'
import { Fauna } from '../world/fauna.js'
import { BuildingSurfaces } from '../world/building-surfaces.js'
import { createGrass } from '../world/grass.js'
import { createSkyIsland } from '../world/skyisland.js'
import { SKY_MARGIN, SKY_MAX_CELLS, groundSize, setFlatAreas, setGroundSize, setIslandFootprint } from '../world/planet.js'
import { createHexIsland } from '../world/hexisland.js'
import { LAND_RINGS, WALL_HALF_WIDTH, blockedByMap, boardMap, createHexBoard, growTown, layoutBoard, layoutFromMap, townGrowth, wallRuns } from '../world/hexboard.js'
import { bendPoint } from '../core/curve.js'
import { Sky } from '../world/sky.js'
import {
  Plot,
  allocateWorld,
  anchorKey,
  cellsNeeded,
  hexToWorld,
  shipPosition,
  createLabel,
  hashString,
  worldToHex,
  DECK_TOP,
  PLOT_PALETTE,
  PLOT_CELL,
} from '../world/plots.js'
import { SHIP_CELL, hexDistance, planMove, setBlockedCells, translateCells, withoutBlocked } from '../world/plot-move.js'
import { createBridge } from '../world/bridge.js'
import { createBuilding, buildingUniforms, medievalLook, Scaffolds } from '../world/buildings.js'
import { Ship } from '../world/ship.js'
import { Astronauts } from '../agents/astronauts.js'
import { Indicators, BADGE } from '../agents/indicators.js'
import { MAX_AGENT_CAP } from '../core/settings.js'
import { Particles } from '../agents/particles.js'
import { Navigation } from '../agents/navigation.js'
import { VILLAGES, VILLAGE_LABEL, placeThreads } from './villages.js'

/**
 * The colony: everything that turns a list of agent threads into a place.
 *
 * The mapping is the whole game. It is a strict precedence rather than a set of independent
 * flags — errored, then running, then merged, then unread — so an astronaut can only ever be
 * telling you one thing, and the loudest true thing wins.
 *
 *   errored        → blocked, red eyes, a `!` over its head
 *   running        → hammering away at its building, sparks flying
 *   PR merged      → celebrating, confetti, a `✓`
 *   unread         → stopped and waiting on you, a bobbing `?` — click it to open the thread
 *   long idle      → asleep on the job
 *   anything else  → pottering about its plot
 *
 * Threads group by repo, one repo per hex plot, and every thread gets a building seeded
 * from its own session id — so the colony's skyline is a stable, readable picture of what
 * you have running.
 */

const STALE_MS = 3 * 24 * 60 * 60 * 1000
/** How wide an astronaut is, for the purpose of not fitting through gaps it should not. */
const AGENT_RADIUS = 0.26
/**
 * The radius the crew *travels* with, which is smaller than the one it stands with. The
 * grid is rasterised at this, so the gaps between buildings stay routes; a shoulder
 * through a wall for a step is the price, and the keep radius sorts it out on arrival.
 */
const TRAVEL_RADIUS = 0.12
/** Progress a live thread adds per second, so a working site visibly grows while you watch. */
const LIVE_GROWTH = 0.004
/** How many zones' positions to remember, including repos with nothing running in them. */
const LAYOUT_MEMORY = 80

export const STATUS_ORDER = ['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping']

export const STATUS_LABEL = {
  working: 'Working',
  waiting: 'Waiting on you',
  blocked: 'Blocked',
  celebrating: 'Shipped',
  idle: 'Idle',
  sleeping: 'Dormant',
  spawning: 'Arriving',
  leaving: 'Heading home',
}

/** Thread → behaviour. First match wins, exactly like the board's auto-sort. */
export function statusFor(thread, now = Date.now()) {
  if (thread.hasError) return 'blocked'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  if (now - thread.lastActivityAt > STALE_MS) return 'sleeping'
  return 'idle'
}

/**
 * Which behaviours earn a badge. Dormant and idle deliberately get none: their pose and
 * face already say it, and with most of a real thread list sitting quiet, a badge over
 * every one of them buries the single `?` that actually wants you.
 */
const BADGE_FOR = {
  waiting: BADGE.waiting,
  blocked: BADGE.blocked,
  working: BADGE.working,
  celebrating: BADGE.done,
  sleeping: BADGE.none,
  idle: BADGE.none,
  spawning: BADGE.spawning,
  leaving: BADGE.leaving,
}

/** Transcript size → how finished the building looks. Log scale: threads grow fast early. */
/**
 * How far along a thread is, on a log scale over its transcript size. This drives the bar
 * on the thread card — it no longer drives how much of the building you can see.
 *
 * It used to. The shader draws construction by sinking the structure into the ground and
 * discarding what falls below the deck, and mapping transcript size onto that meant most
 * buildings stood permanently waist-deep in their own plot. Read as a picture of a colony
 * rather than as a chart, that is not "this thread is young", it is "this building is
 * broken" — a dome cut off by a flat plane looks like a rendering fault, and it is the
 * first thing the eye goes to. So the sink is now only what it is good at: the few seconds
 * of a new building rising out of the ground.
 */
export function transcriptProgress(thread) {
  const size = Math.max(1, thread.sizeBytes || 0)
  return THREE.MathUtils.clamp((Math.log10(size) - 3) / 3.5, 0.05, 1)
}

export class Colony {
  constructor(scene, settings, camera, renderer) {
    this.scene = scene
    this.settings = settings
    this.camera = camera
    this.renderer = renderer

    this.planet = PLANETS[settings.get('planet')] || PLANETS.moon
    this._applyPlanetTint()
    this.sky = new Sky(scene, settings, renderer)
    this.sky.setPlanet(this.planet)
    // Push the stored time in explicitly. `settings.set` is a no-op when the value has not
    // changed, so a colony restored at dusk would otherwise open in the morning and stay
    // there until something happened to touch the slider.
    this.sky.setTime(settings.get('timeOfDay'))

    this.plots = new Map()
    this.plotOrder = []
    /**
     * Where every zone sits, kept across polls *and* across the departures of the threads
     * that made it: a repo whose last session you archive comes back to the same ground
     * when a new one starts. Seeded from the colony file by `restoreLayout`.
     */
    this.plotCells = new Map()
    this.buildings = new Map()
    this.buildingSurfaces = new BuildingSurfaces(this.buildings, (x, z) => this.surfaceAt(x, z))
    this.threads = new Map()
    this.usedAccents = new Set()

    this.worldGroup = new THREE.Group()
    this.worldGroup.name = 'world'
    scene.add(this.worldGroup)

    this.ship = new Ship(scene, shipPosition())
    this.astronauts = new Astronauts(scene, settings)
    this.astronauts.setCrewStyle(this.planet.crew)
    this.astronauts.world = this._world()
    // Sized for the largest preset rather than the current one: unlike the astronaut meshes these
    // buffers are never rebuilt, so allocating against today's `maxAgents` means raising quality
    // later silently starves the badges — the one `?` that wants you being the thing that goes
    // missing. A badge is a single quad; the spare instances cost almost nothing.
    this.indicators = new Indicators(scene, settings, MAX_AGENT_CAP)
    this.particles = new Particles(scene, settings)
    this.scaffolds = new Scaffolds(scene, 320)
    // Birds, butterflies, fish and the cargo drones: the life that carries no information.
    this.fauna = new Fauna(scene, settings)
    this.reflections = new SceneryReflections({
      scene, renderer, settings, sky: this.sky, astronauts: this.astronauts,
      excluded: () => [this.labelGroup, this.indicators.mesh, this.particles.points,
        this.fauna.group, this.grass?.mesh],
    })
    /** Set by whoever owns the speakers: (name, x, y, z) for a sound the world just made. */
    this.onSound = null
    this.nav = new Navigation()
    this.astronauts.setNavigation(this.nav)

    this.plotGroup = new THREE.Group()
    this.labelGroup = new THREE.Group()
    scene.add(this.plotGroup, this.labelGroup)

    // Dismissing the HUD has to survive a poll: labels are chrome, and a scan landing while
    // everything is hidden must not quietly put them back on screen.
    this.uiVisible = true
    this.hoveredPlot = null
    this.activePlots = new Set()
    this._dustTint = new THREE.Color(this.planet.ground.high)
    this._c = new THREE.Color()
    this._c2 = new THREE.Color()
    this.stats = { agents: 0, projects: 0, working: 0, waiting: 0, blocked: 0, done: 0 }

    this._buildTerrain()
  }

  // ── terrain ─────────────────────────────────────────────────────────────────────────

  _buildTerrain() {
    if (this.terrain) {
      this.worldGroup.remove(this.terrain)
      this.terrain.geometry.dispose()
      this.terrain.material.dispose()
    }
    if (this.scatterGroup) {
      this.worldGroup.remove(this.scatterGroup)
      disposeTree(this.scatterGroup)
    }

    // An island world is shaped around the colony: the coast has to know the cells first.
    // A tiled world brings its own land: the terrain is all sea bed, bar a hump under the
    // middle that the tiles cover.
    // Big enough to reach past the farthest island, with its meadow and a stretch of sea.
    setGroundSize(2 * (this.worldReach() + PLOT_CELL * 1.5 * (LAND_RINGS + 3)))
    if (this.planet.board) setIslandFootprint([], PLOT_CELL)
    else if (this.planet.shape === 'island') setIslandFootprint(this._footprintCells(), PLOT_CELL)
    this.terrain = createTerrain(this.planet, this.settings.get('groundDetail'))
    this.worldGroup.add(this.terrain)
    this._buildBoard()
    this._buildIsland()
    this._buildWater()
    this._buildScatter()

    // The ship has legs, and legs have to reach the ground. Its landing spot is a fixed hex
    // cell, but the height of that spot is the planet's, so it is set here rather than once
    // at construction — a world with more relief would otherwise leave it hovering.
    const ship = shipPosition()
    this.ship.group.position.y = this.board ? DECK_TOP : terrainHeight(ship.x, ship.z, this.planet)
    this.ship.setStyle(this.planet.board ? 'castle' : 'ship')
    for (const v of this.villageShips?.values() || []) this._seatShip(v)

    this._dustTint.set(this.planet.ground.high)

    // Only when the world itself changed. The terrain is rebuilt for a scatter or detail
    // setting too, and re-seeding the wildlife for that puts every flock back at its spawn
    // point in the middle of the map — a quality toggle should not restart the birds.
    if (this._faunaPlanet !== this.planet.id) {
      this._faunaPlanet = this.planet.id
      this.fauna.setPlanet(this.planet, {
        heightAt: (x, z) => this.groundAt(x, z),
        parcelSurfaceAt: (x, z) => this.buildingSurfaces.at(x, z),
        waterLevel: this.planet.water?.level ?? null,
        waterHeightAt: this.water ? (x, z, t) => this.water.heightAt(x, z, t) : undefined,
      })
    }
    this._syncFaunaSites()
    this._terrainVersion = (this._terrainVersion || 0) + 1
  }

  /** The Medieval planet's hex tiles, laid around whatever cells the colony holds now. */
  _buildBoard() {
    if (this.board) {
      this.worldGroup.remove(this.board)
      this.board.geometry.dispose()
      this.board.material.dispose()
      this.board = null
    }
    this.boardCells = null
    this.villageBoard = null
    if (!this.planet.board) {
      // Off Medieval: whatever bridges and gates the last planet had go with it.
      this.wallGates = new Set()
      this._bridgeSignature = null
      this._syncBridges()
      return
    }
    const footprint = [SHIP_CELL]
    for (const plot of this.plotOrder || []) if (!plot.village || plot.village === 'misc') footprint.push(...plot.cells)
    // A map painted in tools/map-editor.html wins; without one the island is generated.
    const map = growTown(boardMap(), this.townGrowth || 0)
    const cells = map ? layoutFromMap(map, footprint) : layoutBoard(footprint)
    // Each village island is the same template as a generated Misc: its town walled round its
    // plots and castle, then meadow, a river and the coast. Grown about the island's own middle
    // so every island comes out the same shape for the same plots.
    this.villageBoard = new Map()
    for (const [village, a] of this.villageAnchors || []) {
      const own = [...this._islandLand().filter((c) => c.village === village)]
      if (!own.length) continue
      for (const p of this.plotOrder || []) if (p.village === village) own.push(...p.cells)
      const keys = new Set()
      const seed = village === 'sprint' ? 11 : 23
      for (const cell of layoutBoard(own.map((c) => ({ q: c.q - a.q, r: c.r - a.r })), seed).values()) {
        cell.q += a.q
        cell.r += a.r
        const k = `${cell.q},${cell.r}`
        if (cells.has(k)) continue
        cells.set(k, cell)
        keys.add(k)
      }
      this.villageBoard.set(village, keys)
    }
    // The coast may have moved under a bridge's landward end, and where the bridges land
    // decides which runs of wall are gates and where the road out to each one runs.
    this.boardCells = cells
    this._bridgeSignature = null
    this._syncBridges()
    this.wallGates = this._wallGates(cells)
    this.board = createHexBoard(cells, DECK_TOP, { gates: this.wallGates })
    if (!this.board) {
      this.boardCells = null
      return // the kit is not in yet; `onAssetsReady` builds the terrain again
    }
    this.worldGroup.add(this.board)
    // The walls just moved, or arrived: the crew has to know where they are now.
    if (this.nav) this._rebuildNavigation()
  }

  /** Where the drones fly between: the lander, and every building with anyone at it. */
  _syncFaunaSites() {
    const sites = []
    for (const [id, entry] of this.buildings) {
      if (entry.retiring) continue
      const p = entry.mesh.position
      sites.push({ x: p.x, y: p.y, z: p.z, radius: entry.mesh.userData.footprint, active: this._isActive(id) })
    }
    const pad = shipPosition()
    pad.y = this.ship.group.position.y
    this.fauna.setSites({ ship: this.ship.shipDoor(), pad, sites })
  }

  /**
   * What holds a floating island up: nothing. What it needs instead is an underside — rock
   * and roots and vines hanging off the rim — and a sea of cloud far below it.
   */
  _buildIsland() {
    if (this.island) {
      this.worldGroup.remove(this.island.group)
      this.island.dispose()
      this.island = null
    }
    if (this.rock) {
      this.rock.dispose()
      this.rock = null
    }
    if (this.planet.shape !== 'sky') return
    const detail = this.settings.get('groundDetail')
    // The cloud sea and the drifting puffs come from here; the round underside it also
    // builds is switched off, because this island is not round — see `_syncIslandRock`.
    this.island = createSkyIsland({
      planet: this.planet,
      heightAt: (x, z) => terrainHeight(x, z, this.planet),
      rimRadius: this._footprintRadius() + 6,
      quality: detail === 'high' ? 'high' : detail === 'low' ? 'low' : 'medium',
    })
    this.island.meshes.underside.visible = false
    this.island.meshes.vines.visible = false
    this.island.setDaylight(this.sky.dayFactor ?? 1)
    this.worldGroup.add(this.island.group)
    this._syncIslandRock()
  }

  /** Every hex cell the colony holds, plus the ship's, in world space. */
  _footprintCells() {
    const list = []
    for (const plot of this.plotOrder) {
      for (const local of plot.localCenters) list.push({ x: plot.center.x + local.x, z: plot.center.z + local.z })
    }
    const ship = shipPosition()
    list.push({ x: ship.x, z: ship.z })
    for (const c of this._islandLand()) list.push(hexToWorld(c.q, c.r))
    return list.slice(0, SKY_MAX_CELLS)
  }

  _footprintRadius() {
    let r = PLOT_CELL
    for (const c of this._footprintCells()) r = Math.max(r, Math.hypot(c.x, c.z) + PLOT_CELL)
    return r
  }

  /**
   * Whether a point is on the island: within a cell and its grass margin. The terrain's edge
   * frays a little inside the margin, so this stays a touch conservative to keep grass and
   * scatter off the frayed-away bits.
   */
  onIsland(x, z) {
    if (this.planet.shape !== 'sky') return true
    const reach = (PLOT_CELL + SKY_MARGIN) * 0.86
    for (const c of this._footprintCells()) {
      const dx = x - c.x
      const dz = z - c.z
      if (dx * dx + dz * dz < reach * reach) return true
    }
    return false
  }

  /**
   * The rock under the plots, rebuilt whenever the plots change: a jagged plug per cell,
   * so the island is exactly the colony's shape and grows and shrinks with it.
   */
  _syncIslandRock() {
    if (this.planet.shape !== 'sky') return
    if (this.rock) {
      this.rock.dispose()
      this.rock = null
    }
    const cells = this._footprintCells()
    this.terrain.userData.setFootprint?.(cells, PLOT_CELL + SKY_MARGIN)
    const detail = this.settings.get('groundDetail')
    const p = this.planet.skyIsland || {}
    this.rock = createHexIsland({
      cells,
      cellRadius: PLOT_CELL,
      margin: SKY_MARGIN,
      palette: { soil: p.soil, rock: p.rock, vine: p.vine, moss: this.planet.ground.low },
      quality: detail === 'low' ? 'low' : 'medium',
    })
    this.worldGroup.add(this.rock.group)
  }

  /**
   * The sea, the lakes, or the lava — whatever this world has that is not ground. One plane
   * at the planet's water level; where the terrain is lower, there is water.
   */
  _buildWater() {
    if (this.water) {
      this.worldGroup.remove(this.water.mesh)
      this.water.dispose()
      this.water = null
    }
    const detail = this.settings.get('groundDetail')
    this.water = createWater({
      planet: this.planet,
      size: groundSize(),
      heightAt: (x, z) => terrainHeight(x, z, this.planet),
      quality: detail === 'high' ? 'high' : detail === 'low' ? 'low' : 'medium',
    })
    if (this.water) this.worldGroup.add(this.water.mesh)
  }

  /** A ring on the water at a point, if there is water there. Safe to call anywhere. */
  ripple(x, z, strength = 1) {
    if (!this.water) return
    if (terrainHeight(x, z, this.planet) >= this.planet.water.level) return
    this.water.ripple(x, z, strength)
  }

  /**
   * Ground scatter, placed to miss every tile of every plot and the ship's apron.
   *
   * Kept separate from the terrain because of *when* it has to run: the world is built
   * before the first roster arrives, so at that point there are no plots to avoid, and
   * boulders and trees end up under decks that are laid on top of them afterwards — poking
   * through in fragments. So this runs again whenever a zone's footprint changes, which is
   * cheap next to rebuilding the terrain mesh alongside it.
   */
  _buildScatter() {
    if (this.scatterGroup) {
      this.worldGroup.remove(this.scatterGroup)
      disposeTree(this.scatterGroup)
    }
    const clear = []
    for (const plot of this.plotOrder) {
      for (const local of plot.localCenters) {
        clear.push({ x: plot.center.x + local.x, z: plot.center.z + local.z, r: 8.6 })
      }
    }
    const ship = shipPosition()
    for (const c of this._islandLand()) clear.push({ ...hexToWorld(c.q, c.r), r: 8.6 })
    // Nothing grows on a bridge, or in the way onto one.
    for (const b of this.bridges || []) {
      const steps = Math.ceil(Math.hypot(b.to.x - b.from.x, b.to.z - b.from.z) / 3)
      for (let i = 0; i <= steps; i++) {
        clear.push({ x: b.from.x + ((b.to.x - b.from.x) * i) / steps, z: b.from.z + ((b.to.z - b.from.z) * i) / steps, r: 4.5 })
      }
    }
    clear.push({ x: ship.x, z: ship.z, r: 7.5 })
    // A tiled world is dressed by its tiles — see hexboard.js.
    const density = this.planet.board ? 0 : this.settings.get('scatterDensity')
    this.scatterGroup = createScatter(this.planet, density, clear, 4242, (x, z) => this.onIsland(x, z))
    this.worldGroup.add(this.scatterGroup)
    this._scatterFootprint = this._plotFootprint()
    this._buildGrass(clear)
    // The crew routes around scatter, so a new scatter is a new navigation grid.
    if (this.nav) this._rebuildNavigation()
  }

  /**
   * The meadow, on worlds that have one. Kept clear of the same ground the scatter is, and
   * rebuilt with it: a plot laid over grass would have blades poking up through the deck.
   */
  _buildGrass(clear) {
    const apron = clear[clear.length - 1]
    if (this.grass) {
      this.grass.dispose()
      this.grass = null
    }
    const detail = this.settings.get('groundDetail')
    this.grass = createGrass({
      planet: this.planet,
      heightAt: (x, z) => terrainHeight(x, z, this.planet),
      blocked: (x, z) => !this.onIsland(x, z) ||
        this.plotOrder.some((plot) => plot.containsWorld(x, z, -0.4)) ||
        (apron && (x - apron.x) ** 2 + (z - apron.z) ** 2 < apron.r * apron.r),
      density: this.planet.board ? 0 : this.settings.get('scatterDensity'),
      quality: detail === 'high' ? 'high' : detail === 'low' ? 'low' : 'medium',
    })
    if (this.grass) this.worldGroup.add(this.grass.mesh)
  }

  /** What the scatter has to avoid, as one string — cheap to compare every poll. */
  _plotFootprint() {
    return this.plotOrder.map((plot) => plot.signature).join('|')
  }

  /**
   * Called once the model kits are in.
   *
   * The colony is built before boot has finished fetching them, so the first terrain is
   * scattered with fallback primitives. Rebuilding it here is what puts the real trees and
   * boulders down — without it the ground keeps its placeholders until something else
   * happens to invalidate the terrain, which on a colony nobody touches is never.
   */
  onAssetsReady() {
    this._buildTerrain()
  }

  setPlanet(id) {
    const planet = PLANETS[id]
    if (!planet || planet === this.planet) return
    this.planet = planet
    this.reflections.invalidate()
    this._applyPlanetTint()
    this.sky.setPlanet(planet)
    // Where the village islands stand depends on the planet (Medieval's painted coast pushes
    // them out), so place them for this one first: building the ground round last planet's
    // islands drops them on this one's mainland until the next scan moves them.
    const built = this._terrainVersion
    if (this._lastRoster) {
      const [threads, archivedIds, hiddenProjects, , villages] = this._lastRoster
      this.setThreads(threads, archivedIds, hiddenProjects, new Set(this.threads.keys()), villages)
    }
    if (this._terrainVersion === built) this._buildTerrain()
    this.astronauts.setCrewStyle(planet.crew)
    for (const plot of this.plots.values()) plot.setGround(this._groundStyle())
    // A planet with buildings of its own rebuilds every standing one now, not on the next scan.
    for (const entry of this.buildings.values()) if (entry.thread && !entry.retiring) this._restyleBuilding(entry)
  }

  /**
   * The buildings' shared planet-tint uniforms. Shared is the point: every standing
   * building re-themes on a planet switch without a single rebuild.
   */
  _applyPlanetTint() {
    const tint = this.planet.buildingTint
    buildingUniforms.uPlanetTint.value.set(tint ?? 0xffffff)
    buildingUniforms.uPlanetTintAmount.value = tint != null ? 1 : 0
  }

  onSettingsChanged(changed, scope) {
    if (changed.has('planet')) this.setPlanet(this.settings.get('planet'))
    else if (scope.world) this._buildTerrain()

    this.sky.onSettingsChanged(changed)
    this.astronauts.onSettingsChanged(changed)
    this.particles.onSettingsChanged(changed)
    this.fauna.onSettingsChanged(changed)
    if (changed.has('clouds')) this.sky.setPlanet(this.planet)
    if (changed.has('showLabels')) this._syncLabels()
    if (changed.has('timeOfDay')) this.sky.setTime(this.settings.get('timeOfDay'))
  }

  // ── roster ──────────────────────────────────────────────────────────────────────────

  /**
   * Take a fresh scan and reshape the colony around it. Everything here is keyed by stable
   * ids — repo name for plots, session id for buildings — so a poll that changes nothing
   * moves nothing on screen.
   */
  setThreads(threads, archivedIds = new Set(), hiddenProjects = new Set(), knownIds = new Set(), villages = {}) {
    this._lastRoster = [threads, archivedIds, hiddenProjects, knownIds, villages]
    const now = Date.now()
    // Where every thread goes: a hex you put it in, or its repo's plot in Misc. Plots are keyed
    // by that group's id — the repo name for Misc, `hex:<id>` for a hex.
    const { groups } = placeThreads({
      threads,
      archivedIds,
      hiddenProjects,
      hexes: villages.hexes,
      placements: villages.placements,
    })
    this.plotMeta = groups
    const byProject = new Map()
    for (const [id, group] of groups) byProject.set(id, group.threads)
    const live = [...groups.values()].flatMap((g) => g.threads)
    // Which plot each thread stands on, for anything that has to find it from the thread.
    this.plotOfThread = new Map()
    for (const [id, group] of groups) for (const t of group.threads) this.plotOfThread.set(t.id, id)
    /**
     * Repos where nothing has stirred in days, folded away on request.
     *
     * A colony is a map you learn, and a map is only learnable if what is on it is worth
     * looking at. Someone with a hundred checkouts has most of the ground given over to work
     * they finished in the spring, and the six repos they are actually living in are somewhere
     * in among it. Dormant is already a status the colony understands — nothing for three days
     * — so this is that same line drawn one level up, at the repo rather than the thread.
     *
     * Deliberately all-or-nothing per repo: a zone with one live thread in it stays whole,
     * because half a zone would misrepresent the repo rather than tidy the map.
     */
    const dormant = new Set()
    if (this.settings.get('hideDormant')) {
      for (const [name, list] of byProject) {
        // Misc only: a hex is somewhere you put work on purpose, and an empty one is not dormant.
        if (groups.get(name)?.village !== 'misc') continue
        if (list.every((t) => statusFor(t, now) === 'sleeping')) dormant.add(name)
      }
      // Never fold away everything: a colony that answers a poll with an empty planet reads as
      // broken rather than tidy, and there is nothing on screen to tell you which it was.
      if (dormant.size === byProject.size) dormant.clear()
      for (const name of dormant) byProject.delete(name)
    }
    this.dormantProjects = dormant
    for (const name of dormant) for (const t of groups.get(name).threads) this.plotOfThread.delete(t.id)

    const projects = [...byProject.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length
      return a[0].localeCompare(b[0])
    })

    this._syncPlots(projects)

    // A repo that is off the map keeps its footprint in layout memory, so showing it again
    // reclaims the same ground if it is still free. Re-inserting the entry also keeps
    // LAYOUT_MEMORY from evicting a name you only hid — otherwise a zone folded away for a
    // week loses where it used to be, and comes back somewhere else entirely.
    for (const name of [...hiddenProjects, ...dormant]) {
      const cells = this.plotCells.get(name)
      if (!cells) continue
      this.plotCells.delete(name)
      this.plotCells.set(name, cells)
    }

    const roster = []
    const seenBuildings = new Set()
    const stats = { agents: 0, projects: projects.length }
    for (const key of STATUS_ORDER) stats[key] = 0
    // Plots holding anything that wants your attention get a pulsing rim, so you can spot
    // the repo that needs you from right across the colony without reading a single label.
    const urgent = new Set()
    // Plots with anyone working, waiting or stuck keep their name on screen; quiet ones
    // only show it on hover.
    const active = new Set()

    for (const [name, list] of projects) {
      const plot = this.plots.get(name)
      if (!plot) continue
      // Oldest thread first, so the *first* assignment of slots is deterministic; after that a
      // thread keeps the slot it was given for as long as the plot stands. Numbering by
      // position in this list, which is what this used to do, meant one archive shifted every
      // younger sibling one slot along — every building on the plot moved and every
      // astronaut walked, for a thread that had left.
      list.sort((a, b) => a.createdAt - b.createdAt)
      const slotOf = plot.slotOf || (plot.slotOf = new Map())
      for (const id of [...slotOf.keys()]) if (!list.some((t) => t.id === id)) slotOf.delete(id)
      const taken = new Set(slotOf.values())
      for (const thread of list) {
        if (slotOf.has(thread.id)) continue
        let slot = 0
        while (taken.has(slot)) slot++
        taken.add(slot)
        slotOf.set(thread.id, slot)
      }

      list.forEach((thread) => {
        const i = slotOf.get(thread.id)
        const status = statusFor(thread, now)
        if (stats[status] !== undefined) stats[status]++
        if (status === 'waiting' || status === 'blocked') urgent.add(plot.id)
        if (status === 'waiting' || status === 'blocked' || status === 'working') active.add(plot.id)
        stats.agents++

        const building = this._syncBuilding(thread, plot, i, status)
        seenBuildings.add(thread.id)

        roster.push({
          id: thread.id,
          // Its village's castle is where it comes out and goes home.
          home: plot.village && this.villageShips?.has(plot.village) ? plot.village : 'misc',
          thread,
          status,
          site: null, // assigned after all buildings have reached the navigation map
          // Where the work actually is. A working astronaut circles it rather than standing
          // at one spot, so it needs the building, not just a place to stand near it.
          anchor: building.mesh.position.clone(),
          // Already on the colony's books, so it does not need an entrance.
          known: knownIds.has(thread.id),
          // The repo's colour, so a skeleton's cloth matches its plot and buildings.
          accent: plot.accent,
        })
      })
    }

    // Anything that dropped out of the scan — archived, or a transcript that vanished —
    // takes its building down and walks its astronaut back to the ship.
    for (const [id, entry] of this.buildings) {
      if (!seenBuildings.has(id)) this._removeBuilding(id, entry)
    }

    this.threads = new Map(live.map((t) => [t.id, t]))
    this.urgentPlots = urgent
    this.activePlots = active
    this._rebuildNavigation()
    for (const member of roster) {
      const entry = this.buildings.get(member.id)
      member.site = this._workSite(this.plots.get(entry.plot), entry, entry.slot)
    }
    this._syncFaunaSites()
    this.stats = { ...stats, done: stats.celebrating }
    this.astronauts.setRoster(roster, this._world())
    return this.stats
  }

  _syncPlots(projects) {
    // The previous layout is an input, so a zone only moves when its own footprint changes
    // — never because a different repo gained or lost a thread. `plotCells` carries it
    // between polls, and the colony file carries it between sessions.
    // A painted map's roads, rivers and woods stay put: zones grow round them.
    // The town grows when the colony outgrows it: the wall and all beyond it move out a ring.
    // Never back in, so a repo going quiet does not knock the wall down on its neighbours.
    const sizes = projects.map(([name, list]) => ({ id: name, size: list.length, village: this.plotMeta?.get(name)?.village }))
    if (this.planet.board && boardMap()) {
      // Only Misc is in town: the village islands stand out at sea, past the wall.
      const need = sizes.filter((p) => !p.village || p.village === 'misc').reduce((n, p) => n + cellsNeeded(p.size), 0)
      const grown = townGrowth(boardMap(), need, this.townGrowth || 0)
      if (grown !== (this.townGrowth || 0)) this._townGrew = true
      this.townGrowth = grown
    }
    setBlockedCells(this.planet.board ? blockedByMap(growTown(boardMap(), this.townGrowth || 0)) : [])
    // Misc as it always was, and each village an island of its own out at sea.
    // A painted map is land of its own: the islands stand out past its coast.
    const painted = this.planet.board && growTown(boardMap(), this.townGrowth || 0)
    const mainland = painted ? new Set(painted.cells.map(([q, r]) => `${q},${r}`)) : null
    const { layout, anchors, memory } = allocateWorld(sizes, this.plotCells, { mainland, landRings: this.planet.board ? LAND_RINGS : 0 })
    this.villageAnchors = anchors
    // Remembered, not replaced: a project that has just lost its last thread keeps its
    // ground on the books, and the oldest entries fall off the end. The island middles ride
    // along under their own keys, refreshed every pass so they are never the oldest.
    for (const [name, cells] of memory) {
      this.plotCells.delete(name)
      this.plotCells.set(name, cells)
    }
    while (this.plotCells.size > LAYOUT_MEMORY) this.plotCells.delete(this.plotCells.keys().next().value)

    const wanted = new Map()
    for (const [name, cells] of layout) wanted.set(name, `${name}:${cells.map((c) => `${c.q},${c.r}`).join('/')}`)

    // A plot is rebuilt whenever its own footprint moved, and left completely alone
    // whenever it did not.
    for (const [name, plot] of this.plots) {
      if (wanted.get(name) === plot.signature) continue
      this.plotGroup.remove(plot.group)
      if (plot.label) {
        this.labelGroup.remove(plot.label)
        plot.label.userData.dispose?.()
      }
      this.usedAccents.delete(plot.accent)
      plot.dispose()
      this.plots.delete(name)
    }

    projects.forEach(([name], index) => {
      const standing = this.plots.get(name)
      // A hex renamed since: new name plate, same ground.
      const renamed = this.plotMeta?.get(name)?.name
      if (standing && renamed && standing.name !== renamed) {
        standing.name = renamed
        this.labelGroup.remove(standing.label)
        standing.label.userData.dispose?.()
        standing.label = createLabel(renamed, standing.accent)
        standing.label.position.set(standing.labelAnchor.x, 3.2, standing.labelAnchor.z)
        this.labelGroup.add(standing.label)
      }
      if (standing) return
      const cells = layout.get(name)
      if (!cells?.length) return
      const accent = this._pickAccent(name)
      const meta = this.plotMeta?.get(name)
      const label = meta?.name || name
      const plot = new Plot({ id: name, name: label, index, cells, accent })
      plot.village = meta?.village || 'misc'
      plot.hexId = meta?.hexId || null
      plot.setGround(this._groundStyle())
      plot.signature = wanted.get(name)
      this.plots.set(name, plot)
      this.plotGroup.add(plot.group)

      const tag = createLabel(label, accent)
      tag.position.set(plot.labelAnchor.x, 3.2, plot.labelAnchor.z)
      plot.label = tag
      this.labelGroup.add(tag)
    })

    this.plotOrder = [...this.plots.values()]
    this._syncVillageShips()
    this._syncBridges()
    this._syncVillageLabels()
    // Zones that just moved, appeared or grew are zones the scatter does not know about —
    // nor, on a floating island, the rock under them; and on an island in the sea, the
    // coast itself moves, which is the whole terrain.
    if (this.scatterGroup && (this._townGrew || this._flatsChanged || this._plotFootprint() !== this._scatterFootprint)) {
      this._townGrew = false
      const flatsChanged = this._flatsChanged
      this._flatsChanged = false
      // New flat ground is a new height field: the whole terrain, not just what stands on it.
      if (this.planet.shape === 'island' || this.planet.board || flatsChanged) this._buildTerrain()
      else {
        this._buildScatter()
        if (this.island) this._syncIslandRock()
      }
    }
    // Which hex cells are decked. Ground height is asked for once per moving agent per
    // frame, so it wants to be a lookup rather than a scan over every plot's every tile.
    this.deckedCells = new Set()
    for (const plot of this.plotOrder) {
      for (const cell of plot.cells) this.deckedCells.add(`${cell.q},${cell.r}`)
    }
    this._syncLabels()
  }

  /**
   * How high the ground is at a world point — the surface anything walking stands on.
   *
   * A plot's tiles are a raised slab, so on one of those it is the deck; everywhere else it
   * is the terrain, sampled from the same noise field the mesh was built from. Without this
   * the crew walks along y=0 while the ground around them runs from -0.35 to +0.20, and they
   * spend half the colony buried to the shins.
   */
  /** The bits of the world the crew needs to know about, as plain callbacks. */
  _world() {
    return {
      // Each village island has a castle of its own; its crew come and go by that door.
      shipDoor: (home) => (this.villageShips?.get(home)?.ship || this.ship).shipDoor(),
      shipAirlock: (home) => (this.villageShips?.get(home)?.ship || this.ship).shipAirlock(),
      groundAt: (x, z) => this.groundAt(x, z),
    }
  }

  groundAt(x, z) {
    const cell = worldToHex(x, z)
    if (this.deckedCells?.has(`${cell.q},${cell.r}`)) return DECK_TOP
    if (this.boardCells?.has(`${cell.q},${cell.r}`)) return DECK_TOP
    if (this.bridges?.some((b) => b.contains(x, z))) return DECK_TOP
    return terrainHeight(x, z, this.planet)
  }

  /** The surface anything floating or falling meets: the water where there is water, else the ground. */
  surfaceAt(x, z) {
    const ground = this.groundAt(x, z)
    const level = this.planet.water?.level
    return level !== undefined && ground < level ? level : ground
  }

  /** A stable colour per repo, probing forward on a collision so no two plots match. */
  _pickAccent(name) {
    const start = hashString(name) % PLOT_PALETTE.length
    for (let i = 0; i < PLOT_PALETTE.length; i++) {
      const accent = PLOT_PALETTE[(start + i) % PLOT_PALETTE.length]
      if (!this.usedAccents.has(accent)) {
        this.usedAccents.add(accent)
        return accent
      }
    }
    return PLOT_PALETTE[start]
  }

  /**
   * What a thread's building is made of on this planet. The space kit's is fixed by the
   * thread id; a medieval one also follows the thread's status and how far along it is.
   */
  _buildingSpec(thread, plot, status) {
    const seed = hashString(thread.id)
    const medieval = this.planet.buildings === 'medieval' ? medievalLook(seed, transcriptProgress(thread), status) : null
    return { seed, accent: plot.accent, medieval }
  }

  /**
   * Swap a standing building for the one its thread should show now: a planet switch, or a
   * medieval building changing colour or stage. Same place and turn, already whole: only
   * a new building rises out of the ground.
   */
  /** Medieval plots are meadow; every other planet keeps the metal deck. */
  _groundStyle() {
    return this.planet.board ? 'tiles' : this.planet.buildings === 'medieval' ? 'grass' : 'plate'
  }

  _restyleBuilding(entry) {
    const spec = this._buildingSpec(entry.thread, { accent: entry.accent }, entry.status)
    if ((spec.medieval?.look || 'space') === entry.mesh.userData.look) return
    const old = entry.mesh
    const mesh = createBuilding(spec)
    mesh.position.copy(old.position)
    mesh.rotation.y = old.rotation.y
    mesh.userData.setProgress(entry.progress)
    this.worldGroup.add(mesh)
    this.worldGroup.remove(old)
    old.geometry.dispose()
    old.material.dispose()
    old.customDepthMaterial?.dispose()
    entry.mesh = mesh
  }

  _syncBuilding(thread, plot, index, status) {
    let entry = this.buildings.get(thread.id)
    // Whole, always. A building that has finished rising is a building you can see all of.
    const target = 1

    if (!entry) {
      const mesh = createBuilding(this._buildingSpec(thread, plot, status))
      const pos = plot.worldSlot(index)
      mesh.position.copy(pos)
      mesh.rotation.y = ((hashString(thread.id) >>> 8) % 360) * (Math.PI / 180)
      // New buildings rise from nothing rather than appearing whole.
      mesh.userData.setProgress(0)
      this.worldGroup.add(mesh)
      entry = { mesh, plot: plot.id, slot: index, progress: 0, target, retiring: false }
      this.buildings.set(thread.id, entry)
    } else {
      // Where this building belongs *now*. Comparing the world position rather than the
      // plot id and slot number is what catches a zone that was rebuilt underneath it: the
      // repo is the same and the slot is the same, but the ground moved, and a habitat left
      // behind on bare terrain takes its astronaut off the plot with it.
      const want = plot.worldSlot(index, this._slotAt || (this._slotAt = new THREE.Vector3()))
      if (entry.plot !== plot.id || entry.slot !== index || entry.mesh.position.distanceToSquared(want) > 1e-4) {
        entry.plot = plot.id
        entry.slot = index
        entry.mesh.position.copy(want)
      }
    }

    entry.target = target
    entry.accent = plot.accent
    entry.retiring = false
    entry.thread = thread
    entry.status = status
    this._restyleBuilding(entry)
    return entry
  }

  _removeBuilding(id, entry) {
    // Wind the reveal back down, then take it out — a building that vanishes mid-frame
    // reads as a glitch, one that sinks reads as being packed up.
    entry.retiring = true
    entry.target = 0
    if (entry.progress <= 0.02) {
      this.worldGroup.remove(entry.mesh)
      entry.mesh.geometry.dispose()
      entry.mesh.material.dispose()
      entry.mesh.customDepthMaterial?.dispose()
      this.buildings.delete(id)
    }
  }

  /**
   * Hand the navigation grid the colony's current footprint.
   *
   * The blocking radius is the building's bounding radius trimmed a little, plus the
   * astronaut's own width. The trim matters: the bounding radius already over-covers
   * anything that is not round, and blocking the full extent closes the gaps between a ring
   * of buildings, which is exactly where the crew needs to walk.
   */
  _rebuildNavigation() {
    const obstacles = []
    for (const entry of this.buildings.values()) {
      if (entry.retiring) continue
      const p = entry.mesh.position
      const footprint = entry.mesh.userData.footprint || 1.2
      const r = footprint * 0.8 + TRAVEL_RADIUS
      // The grid blocks less than the whole footprint so the gaps stay walkable; the
      // keep radius is where the crew is actually held to — see `Navigation.repel`.
      obstacles.push({ x: p.x, z: p.z, r, keep: footprint * 0.92 + AGENT_RADIUS })
      // The circle is sized to the building's sides, and a building stands turned, so its
      // corners reach past the circle, up to 40% on the medieval models, and a builder
      // could stand with its shoulder through a wall. Posts along the real, turned outline
      // close that, without fattening the circle until it shuts the gaps between buildings.
      const box = entry.mesh.userData.box
      if (box) {
        const cos = Math.cos(entry.mesh.rotation.y)
        const sin = Math.sin(entry.mesh.rotation.y)
        const post = 0.22
        const edge = (x0, z0, x1, z1) => {
          const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.45))
          for (let i = 0; i < steps; i++) {
            const lx = x0 + ((x1 - x0) * i) / steps
            const lz = z0 + ((z1 - z0) * i) / steps
            // three.js turns a point about Y as (x cos + z sin, −x sin + z cos).
            obstacles.push({ x: p.x + lx * cos + lz * sin, z: p.z - lx * sin + lz * cos, r: post + TRAVEL_RADIUS, keep: post + AGENT_RADIUS })
          }
        }
        edge(box.minX, box.minZ, box.maxX, box.minZ)
        edge(box.maxX, box.minZ, box.maxX, box.maxZ)
        edge(box.maxX, box.maxZ, box.minX, box.maxZ)
        edge(box.minX, box.maxZ, box.minX, box.minZ)
      }
    }
    // The town wall. A row of posts along every run, close enough that no gap between them
    // lets anyone through, both routed round and held to, so nobody wanders out of town.
    if (this.boardCells) {
      const r = WALL_HALF_WIDTH
      for (const w of wallRuns(this.boardCells)) {
        const steps = Math.ceil(w.length / r)
        const gate = this.wallGates?.has(w.id)
        for (let i = 0; i <= steps; i++) {
          const t = i / steps
          // A gate's archway is open: only its ends are wall.
          if (gate && t > 0.2 && t < 0.8) continue
          obstacles.push({ x: w.x0 + (w.x1 - w.x0) * t, z: w.z0 + (w.z1 - w.z0) * t, r: r + TRAVEL_RADIUS, keep: r + AGENT_RADIUS })
        }
      }
    }
    // Ground clutter counts too. A crate is only knee-high, but an astronaut walking
    // straight through one is exactly as wrong as one walking through a habitat.
    for (const plot of this.plotOrder) {
      for (const spot of plot.clutterSpots || []) {
        obstacles.push({ x: plot.center.x + spot.x, z: plot.center.z + spot.z, r: spot.r + TRAVEL_RADIUS, keep: spot.r + AGENT_RADIUS + 0.1 })
      }
    }
    // Ground scatter counts as well. A boulder an astronaut can walk through is the same
    // bug as a habitat it can walk through, and a sleeping one parked inside a solar panel
    // is what that bug looks like from the outside. Instances are read straight off the
    // matrices, so this costs no bookkeeping of its own.
    const mat = this._navMatrix || (this._navMatrix = new THREE.Matrix4())
    for (const mesh of this.scatterGroup?.children || []) {
      if (!mesh.isInstancedMesh || !mesh.count) continue
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const box = mesh.geometry.boundingBox
      const spread = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, mat)
        const scale = Math.hypot(mat.elements[0], mat.elements[1], mat.elements[2])
        const r = spread * scale * 0.65
        // Only what an astronaut would visibly stand *inside*. Blocking every pebble and
        // sprig fences the corridors between zones — the crew walks the gaps between plots
        // to get anywhere, and scatter is placed in exactly those gaps.
        if (r < 0.55) continue
        // Held to as well as routed round: a shoulder through a boulder is the same glitch
        // as one through a wall, just smaller.
        obstacles.push({ x: mat.elements[12], z: mat.elements[14], r: r + TRAVEL_RADIUS, keep: r + AGENT_RADIUS + 0.1 })
      }
    }

    // Scaffold poles. They stand just outside the building's own keep radius, exactly
    // where its builder stands, so without these the builder works with a pole through it.
    for (const site of this._scaffoldSites(true)) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.78
        const x = site.x + Math.cos(a) * site.radius
        const z = site.z + Math.sin(a) * site.radius
        if (site.contains && !site.contains(x, z)) continue
        // Routed round at the size it is held to. A pole stands just outside the building's
        // keep, so pole and building together close the gap between them. Routed as a thin
        // stick, the grid saw that gap as open, the crew walked into it, was pushed back, and
        // settled for the near side of its own building instead of its spot on the far side.
        const keep = 0.14 + AGENT_RADIUS + 0.12
        obstacles.push({ x, z, r: keep, keep })
      }
    }

    const ship = shipPosition()
    obstacles.push({ x: ship.x, z: ship.z, r: 3.4 + AGENT_RADIUS })
    for (const v of this.villageShips?.values() || []) {
      const p = v.ship.group.position
      obstacles.push({ x: p.x, z: p.z, r: 3.4 + AGENT_RADIUS })
    }
    this.nav.reach(this.worldReach() + 6)
    this.nav.rebuild(obstacles, this._offLimits())
  }

  /** The plot under a world point. On a hex lattice the nearest cell centre is the cell. */
  plotAt(x, z) {
    let best = null
    let bestD = Infinity
    for (const plot of this.plotOrder) {
      for (const local of plot.localCenters) {
        const dx = x - (plot.center.x + local.x)
        const dz = z - (plot.center.z + local.z)
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          best = plot
        }
      }
    }
    return bestD <= PLOT_CELL * PLOT_CELL ? best : null
  }

  /**
   * The plot whose name plate is under the cursor.
   *
   * Plates are billboarded in the vertex shader — a CPU raycast against the quad would test
   * the geometry as authored, which is not where it ends up on screen. So this repeats the
   * shader's own maths instead: the plate sits at its anchor in view space and spans
   * `half * (0.55 + dist * 0.03)`, which projects to `half * k * P / dist` in NDC.
   *
   * Opacity is deliberately not consulted. A quiet project's plate is invisible until it is
   * pointed at, and it is this hit test that decides it is being pointed at.
   */
  pickLabel(ndcX, ndcY) {
    const view = this._labelView || (this._labelView = new THREE.Vector3())
    const p = this.camera.projectionMatrix.elements
    let best = null
    let bestDist = Infinity
    for (const plot of this.plotOrder) {
      const label = plot.label
      if (!label) continue
      // Bent like the shader bends the anchor, so a far plate is hit where it is drawn.
      const dist = -bendPoint(view.copy(label.position)).applyMatrix4(this.camera.matrixWorldInverse).z
      if (dist <= 0.01 || dist >= bestDist) continue
      const geo = label.geometry.parameters
      const k = 0.55 + dist * 0.03
      const cx = (view.x * p[0]) / dist
      const cy = (view.y * p[5]) / dist
      if (Math.abs(ndcX - cx) > ((geo.width / 2) * k * p[0]) / dist) continue
      if (Math.abs(ndcY - cy) > ((geo.height / 2) * k * p[5]) / dist) continue
      bestDist = dist
      best = plot
    }
    return best
  }

  /**
   * Take the zone layout out of the colony file. Cells arrive as `[q, r]` pairs from a file
   * a person can edit, so anything that is not a pair of whole numbers is dropped rather
   * than trusted — a bad entry would put a zone on a cell that does not exist.
   */
  restoreLayout(saved) {
    const clean = new Map()
    for (const [name, cells] of Object.entries(saved || {})) {
      if (!Array.isArray(cells)) continue
      const list = []
      for (const cell of cells) {
        const q = Array.isArray(cell) ? cell[0] : cell?.q
        const r = Array.isArray(cell) ? cell[1] : cell?.r
        if (Number.isInteger(q) && Number.isInteger(r)) list.push({ q, r })
      }
      if (list.length) clean.set(String(name), list)
    }
    this.plotCells = clean
  }

  /**
   * One big name over each village that has anything in it, floated over the middle of its
   * plots. Rebuilt only when a village's plots change.
   */
  _syncVillageLabels() {
    if (!this.villageLabels) this.villageLabels = new Map()
    const centres = this.villageCentres()
    for (const village of VILLAGES) {
      const at = centres.get(village)
      const has = this.plotOrder.some((p) => p.village === village)
      let label = this.villageLabels.get(village)
      if (!has || (village === 'misc' && !this.plotOrder.some((p) => p.village !== 'misc'))) {
        // Nothing there, or nothing but Misc: a colony without hexes looks as it always did.
        if (label) {
          this.labelGroup.remove(label)
          label.userData.dispose?.()
          this.villageLabels.delete(village)
        }
        continue
      }
      if (!label) {
        label = createLabel(VILLAGE_LABEL[village].toUpperCase(), 0xffffff)
        label.material.opacity = 1
        this.villageLabels.set(village, label)
        this.labelGroup.add(label)
      }
      label.position.set(at.x, 9, at.z)
    }
  }

  /**
   * Where each village is, as a world point: the middle of its plots, or — for one with nothing
   * on it yet — a point out along its own direction.
   */
  villageCentres() {
    const out = new Map()
    for (const village of VILLAGES) {
      const plots = (this.plotOrder || []).filter((p) => p.village === village)
      if (!plots.length) {
        // Nothing on it yet: the island's middle, or the ship for an empty Misc.
        const at = this.villageAnchors?.get(village) || SHIP_CELL
        out.set(village, hexToWorld(at.q, at.r))
        continue
      }
      let x = 0
      let z = 0
      for (const p of plots) {
        const c = p.middle || p.center
        x += c.x
        z += c.z
      }
      out.set(village, { x: x / plots.length, z: z / plots.length })
    }
    return out
  }

  /**
   * A bridge from Misc to each village island that has anything on it: from the Misc cell (or
   * the ship) nearest the island's middle, to the island cell nearest that. Rebuilt only when
   * its ends move.
   */
  _syncBridges() {
    if (!this.bridges) this.bridges = []
    // The bridge leaves from the nearest dry land: Misc, the ship, or a painted map's coast.
    const misc = [SHIP_CELL]
    for (const p of this.plotOrder) if (p.village === 'misc') misc.push(...p.cells)
    const village = new Set(this.plotOrder.filter((p) => p.village !== 'misc').flatMap((p) => p.cells.map((c) => `${c.q},${c.r}`)))
    for (const c of this._islandLand()) village.add(`${c.q},${c.r}`)
    for (const keys of this.villageBoard?.values() || []) for (const k of keys) village.add(k)
    for (const c of this.boardCells?.values?.() || []) if (!village.has(`${c.q},${c.r}`)) misc.push(c)
    const wanted = []
    // Only Medieval's islands are joined up: a painted world of towns and coasts wants its
    // bridges. Anywhere else the islands simply stand apart, each with its own ship.
    for (const [village, anchor] of this.planet.board ? this.villageAnchors || [] : []) {
      const own = [
        ...this.plotOrder.filter((p) => p.village === village).flatMap((p) => p.cells),
        ...this._islandLand().filter((c) => c.village === village),
        ...[...(this.villageBoard?.get(village) || [])].map((k) => this.boardCells.get(k)),
      ]
      if (!own.length) continue
      const near = (list, to) => list.reduce((a, c) => (hexDistance(c, to) < hexDistance(a, to) ? c : a), list[0])
      const a = near(misc, anchor)
      const b = near(own, a)
      wanted.push(`${a.q},${a.r}>${b.q},${b.r}>${village}`)
    }
    // An island growing moves its flat ground even when its bridge stays put.
    const islands = this.plotOrder.filter((p) => p.village !== 'misc').map((p) => p.signature)
    const signature = `${wanted.join('|')}~${islands.join('|')}`
    if (signature === this._bridgeSignature) return
    this._bridgeSignature = signature
    for (const b of this.bridges) {
      this.plotGroup.remove(b.group)
      b.dispose()
    }
    const flats = []
    this.bridges = wanted.map((w) => {
      const [a, b] = w.split('>').slice(0, 2).map((s) => s.split(',').map(Number))
      const from = hexToWorld(a[0], a[1])
      const to = hexToWorld(b[0], b[1])
      const bridge = createBridge(from, to, DECK_TOP)
      bridge.from = from
      bridge.to = to
      bridge.village = w.split('>')[2]
      flats.push({ x0: from.x, z0: from.z, x1: to.x, z1: to.z, r: 6 })
      this.plotGroup.add(bridge.group)
      return bridge
    })
    // The islands and the water under the bridges are kept flat like the colony's own middle,
    // or the hills past it would swallow the decks.
    for (const [village, anchor] of this.villageAnchors || []) {
      const plots = this.plotOrder.filter((p) => p.village === village)
      if (!plots.length) continue
      const c = hexToWorld(anchor.q, anchor.r)
      let r = 0
      for (const cell of [...plots.flatMap((p) => p.cells), ...this._islandLand().filter((l) => l.village === village)]) {
        const w = hexToWorld(cell.q, cell.r)
        r = Math.max(r, Math.hypot(w.x - c.x, w.z - c.z))
      }
      flats.push({ x: c.x, z: c.z, r: r + PLOT_CELL + 4 })
    }
    const flatSignature = JSON.stringify(flats)
    if (flatSignature !== this._flatSignature) {
      this._flatSignature = flatSignature
      setFlatAreas(flats)
      this._flatsChanged = true
    }
  }

  /**
   * Ground nobody walks on: the sea, and a moat of water round each village island that only
   * its bridge crosses. Without it the crew take the straight line to an island, through the
   * water beside the bridge. Sampled once per metre into a mask, rebuilt only when the ground,
   * the plots or the bridges change, since the terrain is costly to ask.
   */
  _offLimits() {
    const islands = []
    for (const p of this.plotOrder || []) if (p.village && p.village !== 'misc') for (const c of p.cells) islands.push(hexToWorld(c.q, c.r))
    const water = this.planet.water?.level
    if (!islands.length && water === undefined) return null
    const half = this.nav.half
    const signature = `${this.planet.id}~${this._terrainVersion}~${half}~${this._bridgeSignature}~${this._plotFootprint()}`
    if (this._maskSignature !== signature) {
      this._maskSignature = signature
      // The ground round each island's castle is land: its crew step off the ramp onto it.
      const land = new Set(this._islandLand().map((c) => `${c.q},${c.r}`))
      const size = half * 2
      const mask = new Uint8Array(size * size)
      const moat = PLOT_CELL * 2.2
      for (let iz = 0; iz < size; iz++) {
        const z = iz - half + 0.5
        for (let ix = 0; ix < size; ix++) {
          const x = ix - half + 0.5
          const cell = worldToHex(x, z)
          if (this.deckedCells?.has(`${cell.q},${cell.r}`) || land.has(`${cell.q},${cell.r}`)) continue
          if (this.bridges?.some((b) => b.contains(x, z))) continue
          let off = water !== undefined && this.groundAt(x, z) < water
          // A world with a sea has its own moat; a dry one gets a ring of no-go round each island.
          if (!off && water === undefined) for (const c of islands) if ((x - c.x) ** 2 + (z - c.z) ** 2 < moat * moat) { off = true; break }
          if (off) mask[iz * size + ix] = 1
        }
      }
      this._walkMask = { half, size, mask }
    }
    const { half: h, size, mask } = this._walkMask
    return (x, z) => {
      const ix = Math.floor(x + h)
      const iz = Math.floor(z + h)
      return ix >= 0 && iz >= 0 && ix < size && iz < size && mask[iz * size + ix] === 1
    }
  }

  /**
   * The land each village island stands its castle on, as cells: the castle's own (the cell
   * the ship has in Misc, measured from the island's middle) and the one joining it to the
   * middle. Only for islands with anything on them.
   */
  _islandLand() {
    const out = []
    for (const [village, a] of this.villageAnchors || []) {
      if (!this.plotOrder?.some((p) => p.village === village)) continue
      out.push({ q: a.q + SHIP_CELL.q, r: a.r + SHIP_CELL.r, village }, { q: a.q - 1, r: a.r + 1, village })
    }
    return out
  }

  /** A castle (or a ship, off Medieval) on each village island that has anything on it. */
  _syncVillageShips() {
    if (!this.villageShips) this.villageShips = new Map()
    const wanted = new Map()
    for (const c of this._islandLand()) if (!wanted.has(c.village)) wanted.set(c.village, c)
    for (const [village, v] of this.villageShips) {
      const at = wanted.get(village)
      if (at && at.q === v.cell.q && at.r === v.cell.r) continue
      v.ship.dispose()
      this.villageShips.delete(village)
    }
    for (const [village, cell] of wanted) {
      if (this.villageShips.has(village)) continue
      const p = hexToWorld(cell.q, cell.r)
      const ship = new Ship(this.worldGroup, new THREE.Vector3(p.x, 0, p.z))
      // Ramp toward the island's own middle, the way the main ship's faces the town's.
      const mid = hexToWorld(this.villageAnchors.get(village).q, this.villageAnchors.get(village).r)
      ship.group.rotation.y = Math.atan2(mid.x - p.x, mid.z - p.z)
      const v = { ship, cell }
      this.villageShips.set(village, v)
      this._seatShip(v)
    }
  }

  /** Stand a village castle on its ground, in the planet's style. */
  _seatShip(v) {
    const p = v.ship.group.position
    v.ship.group.position.y = this.board ? DECK_TOP : terrainHeight(p.x, p.z, this.planet)
    v.ship.setStyle(this.planet.board ? 'castle' : 'ship')
  }

  /**
   * The runs of town wall that become gates: every run crossed by the straight walk from the
   * ship to where a bridge leaves land, so each village island has a way out of town to it.
   */
  _wallGates(board) {
    const gates = new Set()
    if (!this.bridges?.length) return gates
    const ship = shipPosition()
    const cross = (a, b, c, d) => {
      const o = (p, q, r) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x))
      return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)
    }
    const runs = wallRuns(board)
    for (const bridge of this.bridges) {
      // Out of town to the bridge, and on the island, from its castle down to the bridge.
      const castle = this.villageShips?.get(bridge.village)?.ship.group.position
      for (const w of runs) {
        const a = { x: w.x0, z: w.z0 }
        const b = { x: w.x1, z: w.z1 }
        if (cross(ship, bridge.from, a, b) || (castle && cross(castle, bridge.to, a, b))) gates.add(w.id)
      }
    }
    return gates
  }

  /**
   * A drag inside one island. Misc drags as it always did; a village island is moved about its
   * own middle, so its plots slide back together on their own island and never across the water.
   */
  planDrag(name, dq, dr) {
    const village = this.plots.get(name)?.village || 'misc'
    const layout = new Map()
    for (const [id, plot] of this.plots) if ((plot.village || 'misc') === village) layout.set(id, plot.cells)
    const anchor = this.villageAnchors?.get(village)
    if (!anchor) return planMove(layout, name, dq, dr)
    const local = new Map([...layout].map(([id, cells]) => [id, translateCells(cells, -anchor.q, -anchor.r)]))
    const planned = withoutBlocked(() => planMove(local, name, dq, dr))
    return planned && new Map([...planned].map(([id, cells]) => [id, translateCells(cells, anchor.q, anchor.r)]))
  }

  /** How far from the middle anything stands, in metres: the farthest plot edge or the ship. */
  worldReach() {
    let r = 0
    for (const p of this.plotOrder || []) for (const c of p.cells) {
      const w = hexToWorld(c.q, c.r)
      r = Math.max(r, Math.hypot(w.x, w.z) + PLOT_CELL)
    }
    return r
  }

  /** The plot a thread stands on, or null when it is off the map. */
  plotIdFor(threadId) {
    return this.plotOfThread?.get(threadId) ?? null
  }

  /**
   * Hand a plot's remembered ground back, for a hex coming out of the archive. Its cells live in
   * the colony file's hex entry while it is away, so archived hexes never crowd the layout memory.
   */
  rememberPlot(id, cells) {
    if (!cells?.length) return
    this.plotCells.delete(id)
    this.plotCells.set(id, cells.map((c) => (Array.isArray(c) ? { q: c[0], r: c[1] } : { q: c.q, r: c.r })))
  }

  /** Take a plot's ground off the books and return it, as `[q, r]` pairs. */
  forgetPlot(id) {
    const cells = this.plotCells.get(id) || this.plots.get(id)?.cells
    this.plotCells.delete(id)
    return cells ? cells.map((c) => [c.q, c.r]) : null
  }

  /** The same, on the way out. */
  layoutForSave() {
    const out = {}
    for (const [name, cells] of this.plotCells) out[name] = cells.map((c) => [c.q, c.r])
    return out
  }

  setHoveredPlot(plot) {
    this.hoveredPlot = plot || null
  }

  /** The zones actually on the map, name → cells — what a drag validates against. */
  visibleLayout() {
    const out = new Map()
    for (const [name, plot] of this.plots) out.set(name, plot.cells)
    return out
  }

  /**
   * Translate one zone's remembered footprint. Deliberately nothing but the bookkeeping:
   * the caller re-runs the roster pass, and the signature diff in `_syncPlots` is what
   * tears the old plot down and raises it on the new ground — moving the group directly
   * would leave every world coordinate baked into it (centres, slots, label) pointing at
   * where the zone used to be.
   */
  movePlot(name, dq, dr) {
    const cells = this.plotCells.get(name)
    if (!cells || (!dq && !dr)) return
    this.plotCells.set(name, translateCells(cells, dq, dr))
  }

  /**
   * Adopt a whole planned layout at once.
   *
   * A drag no longer moves only the zone under the cursor: carrying one out from between its
   * neighbours strands whatever it was bridging, and `planMove` slides those back into contact
   * rather than refusing the drop. That arrives as a layout for several zones, and it has to
   * land in one write — applied one zone at a time, the intermediate states are fragmented
   * colonies, and any roster pass that ran between them would throw the layout memory away and
   * re-seed the whole map, which is the exact jump the drag exists to prevent.
   *
   * Bookkeeping only, like `movePlot`: the caller re-runs the roster pass, and the signature
   * diff in `_syncPlots` raises each moved zone on its new ground.
   */
  applyLayout(layout) {
    if (!layout) return
    for (const [name, cells] of layout) {
      if (this.plotCells.has(name)) this.plotCells.set(name, cells)
    }
  }

  /**
   * Cosmetic lift while a zone is being dragged. Safe to fake with a raw y-offset because
   * nothing consults it — the real move is a rebuild on drop, and a cancelled drag sets it
   * back to zero. Buildings ride along by position: they live in the world group, not the
   * plot's, so raising the group alone would leave them standing on air.
   */
  setPlotLift(name, dy) {
    const plot = this.plots.get(name)
    if (!plot) return
    plot.group.position.y = dy
    if (plot.label) plot.label.position.y = 3.2 + dy
    const faded = dy > 0
    plot.group.traverse((o) => {
      if (!o.isMesh) return
      o.material.transparent = faded
      o.material.opacity = faded ? 0.55 : 1
    })
    for (const entry of this.buildings.values()) {
      if (entry.plot === name) entry.mesh.position.y = DECK_TOP + dy
    }
  }

  /**
   * Names fade in for the plots that have something going on, and for whichever one you are
   * pointing at. Everywhere else the colony stays unlabelled.
   */
  _updateLabels(dt) {
    const show = this.uiVisible && this.settings.get('showLabels')
    for (const label of this.villageLabels?.values() || []) label.visible = show
    for (const plot of this.plotOrder) {
      const label = plot.label
      if (!label) continue
      // A hex keeps its name up: it is a ticket or a project you made, and an empty one has
      // nothing else on it to tell you what it is.
      const wanted = show && (plot.hexId || this.activePlots.has(plot.id) || this.hoveredPlot === plot) ? 1 : 0
      const next = THREE.MathUtils.damp(label.material.opacity, wanted, 9, dt)
      label.material.opacity = next
      label.visible = next > 0.01
    }
  }

  /** Where the astronaut stands: just outside its building, facing in. */
  _workSite(plot, entry, index) {
    const b = entry.mesh.position
    // Outward from the *middle* of the zone rather than from its root tile: the root sits
    // on one edge of a grown blob, and standing spots measured from there all point the
    // same way instead of fanning around the buildings.
    const middle = plot.middle || plot.center
    const dx = b.x - middle.x
    const dz = b.z - middle.z
    const len = Math.hypot(dx, dz)
    // Buildings in the middle of a plot have no outward direction, so fan those out by index.
    const a = len > 0.2 ? Math.atan2(dz, dx) : (index * 2.4) % (Math.PI * 2)
    // Clear of the building's *own* footprint rather than a fixed 2.35: a big habitat blocks
    // more ground than a small one, and a standing spot inside that radius is a spot the
    // crew can never actually reach — it walks at the wall for as long as the thread lives.
    const blocked = (entry.mesh.userData.footprint || 1.2) * 0.92 + AGENT_RADIUS
    const stand = Math.max(2.35, blocked + 0.5)
    let site = new THREE.Vector3(b.x + Math.cos(a) * stand, 0, b.z + Math.sin(a) * stand)
    // Outward points straight off the zone for a building on its edge, and an astronaut
    // standing in the neighbouring repo's yard reads as belonging to that repo. The inside
    // of its own plot is always the better answer when the outside is somebody else's.
    const onPlot = (v) => {
      const cell = worldToHex(v.x, v.z)
      return plot.cellKeys.has(`${cell.q},${cell.r}`)
    }
    if (!onPlot(site)) {
      const inward = new THREE.Vector3(b.x - Math.cos(a) * stand, 0, b.z - Math.sin(a) * stand)
      if (onPlot(inward)) site = inward
    }
    // Pick against the complete, current map, including scaffolds about to rise. A grid
    // cell alone is insufficient: it can still be inside a building's keep-out radius.
    const free = this.nav?.nearestClear(site.x, site.z, PLOT_CELL, (x, z) => {
      const cell = worldToHex(x, z)
      return plot.cellKeys.has(`${cell.q},${cell.r}`)
    }) || this.nav?.nearestClear(site.x, site.z, PLOT_CELL * 2)
    if (free) site.set(free.x, 0, free.z)
    return site
  }

  // ── per-frame ───────────────────────────────────────────────────────────────────────

  update(dt, elapsed, focus) {
    if (focus) this.sky.setFocus(focus)
    const cycled = this.sky.update(dt, elapsed, this.camera)
    if (cycled) this.settings.values.timeOfDay = this.sky.time

    const night = this.sky.nightFactor ?? 0
    buildingUniforms.uNight.value = night
    // One write turns every rotor in the colony.
    buildingUniforms.uTime.value = elapsed
    this.ship.update(dt, elapsed, night)
    for (const v of this.villageShips?.values() || []) v.ship.update(dt, elapsed, night)

    this._growBuildings(dt)
    this.astronauts.update(dt, elapsed)
    this.astronauts.updateRings(elapsed)
    this.indicators.update(this.astronauts.agents, elapsed, (a) => this._badgeFor(a), (a) => this._roleFor(a))
    this._emit(dt, elapsed)
    this._emitMotes(dt, night)
    this.particles.ambient(dt, this.camera, this.planet, night, (x, z) => this.surfaceAt(x, z))
    this.particles.update(dt)
    this.water?.update(dt, elapsed, this.camera, night, this.sky.sunDir)
    this.grass?.update(dt, elapsed)
    if (this.island) {
      this.island.update(dt, elapsed, this.camera)
      this.island.setDaylight(this.sky.dayFactor ?? 1)
    }
    this.rock?.update(dt, elapsed)
    this.fauna.update(dt, elapsed, this.camera, night, this._faunaHooks || (this._faunaHooks = {
      ripple: (x, z, s) => this.ripple(x, z, s),
      sound: (name, x, y, z) => this.onSound?.(name, x, y, z),
    }))
    this._updatePlots(night, elapsed)
    this._updateScaffolds()
    this._updateLabels(dt)
    this.reflections.update(dt, focus || this.sky.focus, this.camera)
  }

  _growBuildings(dt) {
    for (const [id, entry] of this.buildings) {
      // A running thread's site creeps upward while you watch it.
      if (!entry.retiring && this._isLive(id)) entry.target = Math.min(1, entry.target + LIVE_GROWTH * dt)
      const next = THREE.MathUtils.damp(entry.progress, entry.target, 1.8, dt)
      if (Math.abs(next - entry.progress) > 0.0005) {
        entry.progress = next
        entry.mesh.userData.setProgress(next)
      }
      if (entry.retiring && entry.progress <= 0.02) this._removeBuilding(id, entry)
    }
  }

  _isLive(id) {
    const thread = this.threads.get(id)
    return Boolean(thread && thread.running)
  }

  /** A site somebody is standing at: running, or stopped waiting on you. */
  _isActive(id) {
    const thread = this.threads.get(id)
    return Boolean(thread && (thread.running || thread.unread || thread.hasError))
  }

  _badgeFor(agent) {
    if (agent.state === 'spawning') return BADGE.spawning
    if (agent.state === 'leaving') return BADGE.leaving
    // A badge belongs to the *thread*, not to the spot: an astronaut that has to walk —
    // shoved off its mark by a neighbour, re-routed round a new building — is still the one
    // waiting on you, and the symbol that says so must not blink out for the trip.
    return BADGE_FOR[agent.status] ?? BADGE.none
  }

  /** The pin for an astronaut's part in a shared run: orchestrator, repo session, or none. */
  _roleFor(agent) {
    const role = this.threads.get(agent.id)?.share?.role
    return role === 'orchestrator' ? BADGE.orchestrator : role === 'child' ? BADGE.child : BADGE.none
  }

  /** Particle emission, driven by what each astronaut is doing. */
  _emit(dt, elapsed) {
    if (!this.particles.enabled) return
    const full = this.settings.get('particles') === 'full'

    for (const agent of this.astronauts.agents) {
      if (agent.scale < 0.5) continue
      // What this one is standing on, which on a plot is the deck rather than the terrain
      // under it. Everything thrown off an astronaut has to land back on the same surface.
      const ground = agent.groundY || 0

      if (agent.state === 'at-site' && agent.status === 'working') {
        // Sparks on the downbeat of the hammer swing, not every frame.
        const swing = Math.sin(agent.workSwing)
        if (swing < -0.75 && !agent._sparked) {
          agent._sparked = true
          const c = this._c.set(0x9fe8c0)
          this.particles.weld(
            agent.pos.x + Math.sin(agent.yaw) * 0.55,
            agent.pos.y + 0.55,
            agent.pos.z + Math.cos(agent.yaw) * 0.55,
            c,
            ground
          )
        } else if (swing > 0) {
          agent._sparked = false
        }
      }

      if (agent.state === 'at-site' && agent.status === 'celebrating' && agent.hop > 0.18 && !agent._cheered) {
        agent._cheered = true
        this.particles.cheer(agent.pos.x, agent.pos.y, agent.pos.z, this._c.set(0xffc86a), ground)
      } else if (agent.hop < 0.05) {
        agent._cheered = false
      }

      if (agent.state === 'at-site' && agent.status === 'sleeping' && Math.random() < dt * 0.35) {
        this.particles.snooze(agent.pos.x + 0.2, agent.pos.y + 1.05, agent.pos.z + 0.15)
      }

      // Boot dust, on the footfall.
      if (full && (agent.walkAmp || 0) > 0.4) {
        const step = Math.sin(agent.phase)
        if (step < -0.9 && !agent._stepped) {
          agent._stepped = true
          this.particles.step(agent.pos.x, agent.pos.y, agent.pos.z, this._dustTint, ground)
        } else if (step > 0) {
          agent._stepped = false
        }
      }

      // The ramp notices anyone stepping on or off it.
      if (agent.state === 'spawning' || (agent.state === 'leaving' && agent.scale < 0.6)) {
        if (Math.random() < dt * 3) this.ship.ping()
      }
    }
  }

  /**
   * Light that lives *on* things. Every building near the view sheds a slow mote now and
   * then — warm by day, its plot's accent after dark, when the windows are lit — the lander's
   * beacon draws a few of its own, and on a world with anything growing on it the yard fills
   * with fireflies once the sun is down. Particles spawned around the camera say "weather";
   * these say "this place is alive".
   */
  _emitMotes(dt, night) {
    if (!this.particles.enabled) return
    const full = this.settings.get('particles') === 'full'
    const focus = this.sky.focus
    const c = this._c
    const living = this.planet.scatter !== 'rocks'
    const fireflies = living && night > 0.35
    // Buildings within reach of the view. Everything else is off screen or too far to read.
    const reach = full ? 48 : 34
    const reach2 = reach * reach
    for (const [id, entry] of this.buildings) {
      if (entry.retiring || entry.progress < 0.5) continue
      const p = entry.mesh.position
      const dx = p.x - focus.x
      const dz = p.z - focus.z
      if (dx * dx + dz * dz > reach2) continue
      const live = this._isActive(id)
      // A live site glows more; a dark one still breathes.
      const rate = (live ? 0.9 : 0.28) * (full ? 1 : 0.55) * (0.6 + night * 0.9)
      if (Math.random() < dt * rate) {
        const r = 0.9 + Math.random() * 1.4
        const a = Math.random() * Math.PI * 2
        if (night > 0.35) c.set(entry.accent).lerp(this._c2.set(0xfff0c0), 0.35).multiplyScalar(2.2)
        else c.set(0xfff2d0).multiplyScalar(1.6)
        this.particles.mote(p.x + Math.cos(a) * r, p.y + 0.4 + Math.random() * 1.8, p.z + Math.sin(a) * r, c, 0.055, 4)
      }
      if (fireflies && Math.random() < dt * (full ? 0.7 : 0.35) * night) {
        const r = 1.5 + Math.random() * 3.5
        const a = Math.random() * Math.PI * 2
        c.setRGB(1.5, 2.3, 0.55)
        this.particles.mote(p.x + Math.cos(a) * r, p.y + 0.2 + Math.random() * 1.2, p.z + Math.sin(a) * r, c, 0.07, 5)
      }
    }
    // The lander's beacon and pad lights draw a slow halo of their own.
    const ship = this.ship.group.position
    const sdx = ship.x - focus.x
    const sdz = ship.z - focus.z
    if (this.ship.style !== 'castle' && sdx * sdx + sdz * sdz < reach2 && Math.random() < dt * (0.8 + night * 1.4)) {
      const a = Math.random() * Math.PI * 2
      const r = 2 + Math.random() * 3
      c.setRGB(0.7, 1.4, 2.4)
      this.particles.mote(ship.x + Math.cos(a) * r, ship.y + 0.3 + Math.random() * 5, ship.z + Math.sin(a) * r, c, 0.06, 5)
    }
  }

  _updatePlots(night, elapsed) {
    const urgent = this.urgentPlots
    for (const plot of this.plotOrder) plot.setNight(night, urgent?.has(plot.id) ?? false, elapsed)
  }

  /** Which buildings have scaffolding up right now, and where its poles stand. */
  _scaffoldSites(includePlanned = false) {
    const sites = []
    for (const [id, entry] of this.buildings) {
      // Scaffolding says a thread is running here — the README's own promise. It used to be
      // gated on the building being unfinished as well, which was fine while "unfinished"
      // was most of them and useless the moment buildings stopped standing in a hole.
      if (entry.retiring || (!includePlanned && entry.progress <= 0.03)) continue
      if (!this._isActive(id)) continue
      const p = entry.mesh.position
      sites.push({
        id,
        x: p.x,
        z: p.z,
        y: p.y,
        radius: (entry.mesh.userData.footprint || 1.4) + 0.25,
        contains: (x, z) => this.plots.get(entry.plot)?.containsWorld(x, z, 0.2),
        height: Math.max(0.6, entry.mesh.userData.height * entry.progress + 0.5),
      })
    }
    return sites
  }

  _updateScaffolds() {
    const sites = this._scaffoldSites()
    this.scaffolds.update(sites)
    // The poles are things to walk round, so a scaffold going up or coming down is a
    // change to the ground — but only then; the grid is not rebuilt for a building growing.
    const signature = sites.map((s) => s.id).join('|')
    if (signature !== this._scaffoldSignature) {
      this._scaffoldSignature = signature
      if (this.nav) this._rebuildNavigation()
    }
  }

  // ── interaction ─────────────────────────────────────────────────────────────────────

  pick(ndcX, ndcY, aspect) {
    return this.astronauts.pick(this.camera, ndcX, ndcY, aspect)
  }

  agentFor(id) {
    return this.astronauts.byId.get(id)
  }

  setUiVisible(visible) {
    this.uiVisible = visible
    this._syncLabels()
  }

  _syncLabels() {
    // Visibility is per-label now; the group only ever hides everything at once.
    this.labelGroup.visible = true
  }

  dispose() {
    this.reflections.dispose()
    this.sky.dispose()
    this.fauna.dispose()
    this.grass?.dispose()
    this.island?.dispose()
    this.rock?.dispose()
    this.water?.dispose()
    this.ship.dispose()
    for (const v of this.villageShips?.values() || []) v.ship.dispose()
    this.astronauts.dispose()
    this.indicators.dispose()
    this.particles.dispose()
    this.scaffolds.dispose()
    disposeTree(this.worldGroup)
    disposeTree(this.plotGroup)
    disposeTree(this.labelGroup)
    this.scene.remove(this.worldGroup, this.plotGroup, this.labelGroup)
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return
    o.geometry?.dispose()
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose())
    else o.material?.dispose()
  })
}
