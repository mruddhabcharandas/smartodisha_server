import { v2 as cloudinary } from 'cloudinary'

export const configureCloudinary = () => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return false
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  })
  return true
}

export const uploadBuffer = async (buffer, folder='products') => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error('cloudinary_not_configured')
  const res = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ 
      folder,
      quality: "auto:best",
      fetch_format: "auto",
      flags: "preserve_transparency"
    }, (err, result) => {
      if (err) return reject(err)
      resolve(result)
    })
    stream.end(buffer)
  })
  return { url: res.secure_url, publicId: res.public_id }
}

