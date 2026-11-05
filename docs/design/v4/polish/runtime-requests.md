# Studio 3D runtime follow-up

Every `person_1..13.glb` now carries its own 23 bone clips and `eyeBlink` / `mouthOpen` morph tracks. The exported names, rig, timing roles, scale and origins match the current assets. In the current `Studio3D.tsx`, `sharedClips=people[0].animations` gives everyone person 1's clips, and the `index>0` filter removes `morphTargetInfluences`. As a result, only person 1 blinks or speaks in the running app.

When phase 2b is ready, bind each actor's actions from its own `gltf.animations` and keep its morph tracks. If sharing bone clips remains desirable, retain the actor's own morph track while rebinding; verify it drives the actor's `BODY_ATLAS`. The asset contract does not require a particular runtime approach. Check a non-1 actor in `sit_type` for a nonzero `eyeBlink` and in `sofa_talk` for a nonzero `mouthOpen` through the same Three.js mixer.

The long loop clips contain irregular blink keys around 2–6 seconds apart. Brief one-shot transitions are shorter than two seconds; repeated state switching can reset the blink timing. A runtime blink clock or facial overlay would make the interval independent of state transitions if that becomes noticeable.

## Self-shadow artifacts at 2x

The diagonal stripes on faces, hair, shirts, sleeves and trousers are self-shadow acne. `debug-developer-lit.png` captures the normal runtime result; `debug-developer-noshadow.png` captures the same GLB, action, frame and camera with only the actor meshes' `receiveShadow` set to false in the browser. All stripes disappear. Removing the covered body and adding geometry did not change them. The current runtime gives each actor `castShadow=true` and `receiveShadow=true` under a 2048 px map spanning 24 m, with `sun.shadow.bias=-0.0002`. Tune shadow bias/normalBias and/or disable self-receiving on character meshes while preserving cast shadows. Repeat the same 2x desk and status closeups afterward.

## Status chip occludes gestures at 1440

The asset's raised hand is above the head in the 2x closeup, but the `하린 / 답변 대기` chip covers it in `status-hand_raise-1440.png`; the `오류` chip similarly covers the face and hands in `status-head_in_hands-1440.png`. The settled waiting hand is also behind the monitor from the default office camera. Adjust status/name chip placement around projected raised hands or provide a status pose presentation when phase 2b's name tags land. The GLB cannot move the UI chip or camera without a runtime change.
