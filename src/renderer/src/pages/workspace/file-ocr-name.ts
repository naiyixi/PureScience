// The files whose text can only come from OCR. Everything else has a text layer the reader already understands.
const IMAGE_NAME = /\.(png|jpe?g|webp|tiff?|bmp|gif|heic)$/i

export const isImageFileName = (name: string): boolean => IMAGE_NAME.test(name)
