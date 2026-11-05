# Asset requests

1. **Separately addressable chairs.** `room.glb` currently merges furniture by material, so the runtime cannot pick out each desk chair. Please keep the room scale and furniture positions, but export each chair as a named node or separate mesh. The renderer already uses `chair_moving.glb` for one representative chair and falls back to fixed chairs elsewhere. With named chairs it can push back and pull in every occupied chair during `stand_up` and `sit_down`.

2. **Traveling folder hand-off.** The current fallback attaches a small folder prop to `handR` while the existing `walk` clip plays, then uses `hand_over` and `receive` near the desk. A future held-folder walk clip or upper-body layer, plus a matching receiver beat, would make the object transfer easier to read at the default camera distance. Keep the existing clip names and roles.

3. **Foot contacts.** The runtime scales `walk` playback with its 1.2 m/s path speed. Explicit contact markers or an in-place walk clip tuned to that stride would allow stronger foot locking on turns and stops. For now it uses eased starts and stops with clip speed matching.
