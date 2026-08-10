/**
 * config/audio.ts — the synthesized mix.
 * Owns: levels, distances and rolloff for `core/Sfx.ts`.
 * Gotcha: there are zero audio files in this project. Every sound is built
 * from WebAudio primitives, so a level here is a gain node, not a file.
 */

export const audio = {
  /**
   * Concurrent one-shots. Sixteen bots firing is ~80 shots a second; past
   * this many voices the ear can't separate them and the scheduler can't keep
   * up, so extras are dropped rather than queued.
   */
  maxVoices: 24,
  /** Distance at which a world sound plays at full volume. */
  refDistance: 8,
  /** Distance at which it falls silent. Matched roughly to the fog. */
  maxDistance: 70,
  /**
   * Metres per second. A shot across the map arrives ~0.2 s after its muzzle
   * flash, which is the cue that tells the ear how far away a firefight is
   * far more strongly than volume does.
   */
  speedOfSound: 343,
  /**
   * The village answering a gunshot: one shared convolution reverb every shot
   * sends into. Length is the decay of the diffuse tail; a report outdoors is
   * a short transient followed by a few hundred milliseconds of stone and
   * timber, and it is that tail, not the report, that reads as "real gun".
   */
  reverbSeconds: 0.9,
  /** Wet level of that shared bus. */
  reverbMix: 0.5,
  /**
   * Extra reverb send per unit of `maxDistance`. Reverberant energy falls off
   * far more slowly than the direct sound, so a distant shot is mostly tail
   * and a close one is mostly crack.
   */
  reverbDistanceSend: 1.6,

  /**
   * Footsteps. The player's are triggered by the camera's bob phase rather
   * than by a timer of their own — a step you hear off the beat of the dip
   * you see is worse than no step at all — so there is no interval here.
   * What is here is how loud each stance is, and how far a bot's boots
   * carry.
   */
  footstep: {
    /** Walking, sprinting, and how much of that a crouch keeps. */
    walkVol: 0.5,
    sprintVol: 1,
    /**
     * Crouching is already slower and lower (the bob drive is damped by
     * `camera.bobCrouchMult`), so this only has to finish the job. It does
     * NOT make you quieter to the enemy: bots hear gunshots, never feet.
     */
    crouchMult: 0.3,
    /**
     * Impact speed (m/s) below which touching down is just walking, and the
     * speed at which a landing is as loud as it gets. A step off a kerb is
     * a footstep; a drop off the mill roof is not.
     */
    landMinSpeed: 3,
    landFullSpeed: 11,
    /**
     * How far a bot's footfalls carry, well inside `maxDistance` (70). Boots
     * are not rifles: at 70 m they would be inaudible in the mix and would
     * only spend voices the gunfire needs — 16 bots stepping twice a second
     * is 32 one-shots a second on its own. Short range keeps the cue
     * meaningful (someone is close, and roughly there) and the cost small.
     */
    botRange: 20,
  },
} as const;
