// Madgwick AHRS algorithm for JS
// Encapsulates Sebastian Madgwick's orientation filter.
(function (global) {
  'use strict';

  class Madgwick {
    constructor(sampleInterval, beta) {
      this.sampleInterval = sampleInterval || 1.0 / 30.0; // default 30Hz
      this.beta = beta || 0.1; // algorithm gain
      this.q0 = 1.0;
      this.q1 = 0.0;
      this.q2 = 0.0;
      this.q3 = 0.0;
    }

    updateIMU(gx, gy, gz, ax, ay, az) {
      let q0 = this.q0, q1 = this.q1, q2 = this.q2, q3 = this.q3;
      let recipNorm;
      let s0, s1, s2, s3;
      let _2q0, _2q1, _2q2, _2q3, _4q0, _4q1, _4q2, _8q1, _8q2, q0q0, q1q1, q2q2, q3q3;

      // Rate of change of quaternion from gyroscope (converted to rad/s)
      let qDot1 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
      let qDot2 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
      let qDot3 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
      let qDot4 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

      // Compute feedback only if accelerometer measurement valid (avoids NaN in norm)
      if (!((ax === 0.0) && (ay === 0.0) && (az === 0.0))) {
        // Normalise accelerometer measurement
        recipNorm = 1.0 / Math.sqrt(ax * ax + ay * ay + az * az);
        ax *= recipNorm;
        ay *= recipNorm;
        az *= recipNorm;

        // Auxiliary variables to avoid repeated arithmetic
        _2q0 = 2.0 * q0;
        _2q1 = 2.0 * q1;
        _2q2 = 2.0 * q2;
        _2q3 = 2.0 * q3;
        _4q0 = 4.0 * q0;
        _4q1 = 4.0 * q1;
        _4q2 = 4.0 * q2;
        _8q1 = 8.0 * q1;
        _8q2 = 8.0 * q2;
        q0q0 = q0 * q0;
        q1q1 = q1 * q1;
        q2q2 = q2 * q2;
        q3q3 = q3 * q3;

        // Gradient decent algorithm corrective step
        s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
        s1 = _4q1 * q3q3 - _2q3 * ax + 4.0 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
        s2 = 4.0 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
        s3 = 4.0 * q1q1 * q3 - _2q1 * ax + 4.0 * q2q2 * q3 - _2q2 * ay;

        // Normalise step member
        const sNorm = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
        if (sNorm > 0.0001) {
          recipNorm = 1.0 / sNorm;
          s0 *= recipNorm;
          s1 *= recipNorm;
          s2 *= recipNorm;
          s3 *= recipNorm;

          // Apply feedback step
          qDot1 -= this.beta * s0;
          qDot2 -= this.beta * s1;
          qDot3 -= this.beta * s2;
          qDot4 -= this.beta * s3;
        }
      }

      // Integrate rate of change of quaternion to yield quaternion
      q0 += qDot1 * this.sampleInterval;
      q1 += qDot2 * this.sampleInterval;
      q2 += qDot3 * this.sampleInterval;
      q3 += qDot4 * this.sampleInterval;

      // Normalise quaternion
      recipNorm = 1.0 / Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
      this.q0 = q0 * recipNorm;
      this.q1 = q1 * recipNorm;
      this.q2 = q2 * recipNorm;
      this.q3 = q3 * recipNorm;
    }

    // Convert quaternion to Euler angles: alpha (yaw, 0 to 360), beta (pitch, -180 to 180), gamma (roll, -90 to 90)
    getEulerAngles() {
      const q0 = this.q0;
      const q1 = this.q1;
      const q2 = this.q2;
      const q3 = this.q3;

      // roll (x-axis rotation)
      const sinr_cosp = 2 * (q0 * q1 + q2 * q3);
      const cosr_cosp = 1 - 2 * (q1 * q1 + q2 * q2);
      const roll = Math.atan2(sinr_cosp, cosr_cosp);

      // pitch (y-axis rotation)
      const sinp = 2 * (q0 * q2 - q3 * q1);
      let pitch;
      if (Math.abs(sinp) >= 1) {
        pitch = Math.sign(sinp) * (Math.PI / 2); // use 90 degrees if out of range
      } else {
        pitch = Math.asin(sinp);
      }

      // yaw (z-axis rotation)
      const siny_cosp = 2 * (q0 * q3 + q1 * q2);
      const cosy_cosp = 1 - 2 * (q2 * q2 + q3 * q3);
      const yaw = Math.atan2(siny_cosp, cosy_cosp);

      const r2d = 180 / Math.PI;

      // Normalize to matches deviceorientation ranges:
      // Alpha: 0 to 360
      let alpha = yaw * r2d;
      if (alpha < 0) alpha += 360;

      // Beta: -180 to 180
      const beta = pitch * r2d;

      // Gamma: -90 to 90
      const gamma = roll * r2d;

      return { alpha, beta, gamma };
    }
  }

  global.Madgwick = Madgwick;

})(typeof window !== 'undefined' ? window : globalThis);
