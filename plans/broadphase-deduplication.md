# Gameplan: SpatialHashingBroadphase Query Deduplication

## Current State

**File**: `src/core/physics/collision/broadphase/SpatialHashingBroadphase.ts`

Two methods use `indexOf()` to prevent duplicate bodies in query results:

### aabbQuery() - Line 244

```typescript
aabbQuery(_: World, aabb: AABB, result?: Body[], shouldAddBodies: boolean = true): Body[] {
  result = result ?? [];
  // ...
  for (const cell of this.aabbToCells(aabb, false)) {
    for (const body of this.partitions[cell]) {
      if (body.getAABB().overlaps(aabb) && result.indexOf(body) < 0) {  // O(n)
        result.push(body);
      }
    }
  }
  // ...
}
```

### rayQuery() - Line 300

```typescript
rayQuery(ray: RayLike, shouldAddBodies = true): Body[] {
  const result: Body[] = [];
  // ...
  for (const body of this.partitions[cell]) {
    if (result.indexOf(body) < 0) {  // O(n)
      result.push(body);
    }
  }
  // ...
}
```

**Problem**: Bodies can appear in multiple cells. Each `indexOf()` is O(n), making queries O(n²) in worst case.

## Desired Changes

Use a temporary `Set<Body>` to track seen bodies during each query, then convert to array at the end if needed.

## Files to Modify

- `src/core/physics/collision/broadphase/SpatialHashingBroadphase.ts` - Both query methods

## Execution Order

Single file change, no dependencies.

### Changes to `SpatialHashingBroadphase.ts`

#### Option A: Use Set for intermediate tracking

```typescript
// Add reusable Set to class:
private queryResultSet: Set<Body> = new Set();

aabbQuery(_: World, aabb: AABB, result?: Body[], shouldAddBodies: boolean = true): Body[] {
  const resultArray = result ?? [];
  const seen = this.queryResultSet;
  seen.clear();

  // Add existing results to seen set if provided
  for (const body of resultArray) {
    seen.add(body);
  }

  if (shouldAddBodies) {
    this.addExtraBodies();
  }

  for (const cell of this.aabbToCells(aabb, false)) {
    for (const body of this.partitions[cell]) {
      if (body.getAABB().overlaps(aabb) && !seen.has(body)) {
        seen.add(body);
        resultArray.push(body);
      }
    }
  }

  for (const hugeBody of this.hugeBodies) {
    if (aabb.overlaps(hugeBody.getAABB()) && !seen.has(hugeBody)) {
      seen.add(hugeBody);
      resultArray.push(hugeBody);
    }
  }

  if (shouldAddBodies) {
    this.removeExtraBodies();
  }

  return resultArray;
}

rayQuery(ray: RayLike, shouldAddBodies = true): Body[] {
  const result: Body[] = [];
  const seen = this.queryResultSet;
  seen.clear();

  // ... ray traversal logic ...

  for (const body of this.partitions[cell]) {
    if (!seen.has(body)) {
      seen.add(body);
      result.push(body);
    }
  }

  // ...
}
```

#### Note on hugeBodies

The `hugeBodies` loop in `aabbQuery()` doesn't currently check for duplicates - should it? If the same body could be in both `partitions` and `hugeBodies`, this could cause duplicates. Review during implementation.
