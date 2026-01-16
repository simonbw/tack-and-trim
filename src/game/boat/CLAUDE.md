# Boat System

Physics-based sailing simulation with modular components.

## Architecture

Boat is a parent entity with children that handle specific physics:

- **Hull** - Main physics body, water drag
- **Keel** - Lateral resistance (prevents sideslip)
- **Rudder** - Steering, attached to hull with angle constraints
- **Sail** (Mainsail/Jib) - Aerodynamic forces from wind
- **Sheet** - Controls sail trim angle
- **Anchor** - Deploys to stop movement

## Sail Aerodynamics

`SailFlowSimulator` calculates airflow across sail surface. Key concepts:
- Flow attachment/separation based on angle of attack
- Lift/drag coefficients from flow state
- TellTails visualize flow for player feedback

## Adding Boat Components

1. Extend BaseEntity
2. Accept `boat: Boat` in constructor
3. Access hull body via `boat.hull.body`
4. Add as child: `boat.addChild(new MyComponent(boat))`

## Configuration

Boat specs are data-driven via `BoatConfig.ts`. Modify dimensions, sail areas, and physics constants there.
