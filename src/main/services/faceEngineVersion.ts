// Split out from faceDetectionEngine.ts so db.ts can gate the one-time
// full-reset migration (see db.ts's applySchema) on this version string
// without pulling in onnxruntime-node/sharp just to open a database
// connection. Bump this whenever the detection/recognition models or
// descriptor format change in a way that makes previously-stored face
// descriptors incomparable to newly-produced ones.
export const FACE_DATA_VERSION = 'scrfd500m-arcfacembf-v1';
