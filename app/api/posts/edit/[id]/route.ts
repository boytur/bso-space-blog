import { NextRequest, NextResponse } from "next/server";
import prisma from "@/prisma/client";
import { slugify } from "@/app/utils/slugify";
import { v4 as uuidv4 } from "uuid";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Cloudflare R2 settings
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const s3Client = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY!,
    secretAccessKey: R2_SECRET_KEY!,
  },
});

// Function to upload images to Cloudflare R2 if they are blobs
async function uploadImagesFromContent(content: string): Promise<string> {
  const imgTagRegex = /<img[^>]+src="([^">]+)"/g;
  let match;
  const uploads = [];

  // Detect every <img> tag
  while ((match = imgTagRegex.exec(content)) !== null) {
    const imgSrc = match[1];

    // If it's not an external URL (e.g., https://), consider it a blob
    const isExternalUrl = imgSrc.startsWith("https://");
    const oldBucketUrl = imgSrc.startsWith("https://bso-image.posyayee.shop/");

    if (oldBucketUrl) {
      const newImageUrl = imgSrc.replace(
        "https://bso-image.posyayee.shop/",
        `https://assets.bsospace.com/`
      );

      content = content.replace(imgSrc, newImageUrl);
    }

    if (!isExternalUrl) {
      // Separate the image type and base64 data
      const base64Data = imgSrc.split(";base64,").pop();
      const contentTypeMatch = imgSrc.match(/^data:([^;]+);base64/);
      const contentType = contentTypeMatch ? contentTypeMatch[1] : "image/jpeg";

      // Convert file type to file extension
      const fileExtension = contentType.split("/")[1];
      const newFileName = `${uuidv4()}.${fileExtension}`;

      // Decode base64 to Buffer
      const imageBuffer = Buffer.from(base64Data!, "base64");

      // Upload image to Cloudflare R2
      const uploadPromise = s3Client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: newFileName,
          Body: imageBuffer,
          ContentType: contentType,
        })
      );

      // Create new URL from Cloudflare R2
      const newImageUrl = `https://bso-image.posyayee.shop/${newFileName}`;
      content = content.replace(imgSrc, newImageUrl);

      uploads.push(uploadPromise);
    }
  }

  // Wait for all uploads
  await Promise.all(uploads);

  return content;
}

// PUT handler to update a post by ID
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: number } }
) {
  const id = params.id;

  if (!id) {
    return NextResponse.json({ error: "Post ID is required" }, { status: 400 });
  }

  try {
    const { title, content, categoryId, tagIds, key } = await req.json();

    if (!title || !content || !categoryId) {
      return NextResponse.json(
        { error: "Title, content, and category are required" },
        { status: 400 }
      );
    }

    // Generate slug from title
    const slug = slugify(title);

    // Process images in the content
    const updatedContent = await uploadImagesFromContent(content);

    // Update post in the database
    const updatedPost = await prisma.post.update({
      where: { id: Number(id) },
      data: {
        title,
        content: updatedContent,
        slug,
        published: key != null || key != undefined ? false : true,
        key: key || null,
        categoryId: parseInt(categoryId),
        tags: {
          set: [], // Clear existing tags
          connect: tagIds.map((id: number) => ({ id })),
        },
      },
    });

    return NextResponse.json(updatedPost);
  } catch (error: any) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to update post", message: error?.message },
      { status: 500 }
    );
  }
}
