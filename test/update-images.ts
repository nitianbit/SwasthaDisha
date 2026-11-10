import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4030';
const AUTH_TOKEN = process.env.DEV_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  throw new Error('Set DEV_AUTH_TOKEN before running the image update utility');
}

// Image file paths - images are in the test/assets folder
const SPECIALIST_IMAGE = process.env.SPECIALIST_IMAGE_PATH || path.join(
  __dirname,
  'assets/specialist-fd6fd7d9-85ae-49ff-86fa-ad5269185d9c.png'
);
const PACKAGE_IMAGE = process.env.PACKAGE_IMAGE_PATH || path.join(
  __dirname,
  'assets/package1-eb1aeba9-a4e2-4682-ac36-97c00b93e355.png'
);
const BANNER_IMAGE = process.env.BANNER_IMAGE_PATH || path.join(
  __dirname,
  'assets/banner-e185cd78-4636-4533-b0cb-cb4590e570a3.png'
);
const CORPORATE_IMAGE = process.env.CORPORATE_IMAGE_PATH || path.join(
  __dirname,
  'assets/corporate-7c205cc5-8be2-4ea9-86d6-70e5bf363632.png'
);
const PARTNERS_IMAGE = process.env.PARTNERS_IMAGE_PATH || path.join(
  __dirname,
  'assets/partners-dc98b66b-d8b7-4356-a62f-5cd1c882b7ee.png'
);
const HEALTH_TIPS_IMAGE = process.env.HEALTH_TIPS_IMAGE_PATH || path.join(
  __dirname,
  'assets/health-tips-9470bfcb-56da-4965-b521-82b442ccfbe9.png'
);

interface UploadResponse {
  success: boolean;
  data: {
    files: Array<{
      url: string;
      fileName: string;
      originalFileName: string;
    }>;
  };
}

async function uploadFile(
  filePath: string,
  module: string
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const formData = new FormData();
  formData.append('files', fs.createReadStream(filePath));
  formData.append('module', module);

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${BASE_URL}/api/v1/file/upload`,
    headers: {
      ...formData.getHeaders(),
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    data: formData,
  };

  console.log(`📤 Uploading ${module} image...`);
  const response = await axios<UploadResponse>(config);

  if (response.data.success && response.data.data.files.length > 0) {
    const imageUrl = response.data.data.files[0].url;
    console.log(`✅ Uploaded ${module} image: ${imageUrl}`);
    return imageUrl;
  }

  throw new Error(`Failed to upload ${module} image`);
}

async function getAllSpecialists(): Promise<any[]> {
  console.log('📋 Fetching all specialists...');
  const response = await axios.get(`${BASE_URL}/api/v1/specialists`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (response.data.success) {
    const specialists = response.data.data || [];
    console.log(`✅ Found ${specialists.length} specialists`);
    return specialists;
  }

  return [];
}

async function getAllWellnessPackages(): Promise<any[]> {
  console.log('📋 Fetching all wellness packages...');
  const response = await axios.get(`${BASE_URL}/api/v1/wellness-packages`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (response.data.success) {
    const packages = response.data.data || [];
    console.log(`✅ Found ${packages.length} wellness packages`);
    return packages;
  }

  return [];
}

async function getAllBanners(): Promise<any[]> {
  console.log('📋 Fetching all banners...');
  const response = await axios.get(`${BASE_URL}/api/v1/banners`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (response.data.success) {
    const banners = response.data.data || [];
    console.log(`✅ Found ${banners.length} banners`);
    return banners;
  }

  return [];
}

async function getAllCorporates(): Promise<any[]> {
  console.log('📋 Fetching all corporates...');
  const response = await axios.get(`${BASE_URL}/api/v1/corporates`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (response.data.success) {
    const corporates = response.data.data || [];
    console.log(`✅ Found ${corporates.length} corporates`);
    return corporates;
  }

  return [];
}

async function getAllPartners(): Promise<any[]> {
  console.log('📋 Fetching all partners...');
  const response = await axios.get(`${BASE_URL}/api/v1/partners`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (response.data.success) {
    const partners = response.data.data || [];
    console.log(`✅ Found ${partners.length} partners`);
    return partners;
  }

  return [];
}

async function getAllHealthTips(): Promise<any[]> {
  console.log('📋 Fetching all health tips...');
  const response = await axios.get(`${BASE_URL}/api/v1/health-tips`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (response.data.success) {
    const healthTips = response.data.data || [];
    console.log(`✅ Found ${healthTips.length} health tips`);
    return healthTips;
  }

  return [];
}

async function updateSpecialist(id: string, imageUrl: string): Promise<void> {
  console.log(`  Updating specialist ${id}...`);
  await axios.put(
    `${BASE_URL}/api/v1/specialists/${id}`,
    { profilePictureUrl: imageUrl },
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`  ✅ Updated specialist ${id}`);
}

async function updateWellnessPackage(id: string, imageUrl: string): Promise<void> {
  console.log(`  Updating wellness package ${id}...`);
  await axios.put(
    `${BASE_URL}/api/v1/wellness-packages/${id}`,
    { imageUrl: imageUrl },
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`  ✅ Updated wellness package ${id}`);
}

async function updateBanner(id: string, imageUrl: string): Promise<void> {
  console.log(`  Updating banner ${id}...`);
  await axios.put(
    `${BASE_URL}/api/v1/banners/${id}`,
    { imageUrl: imageUrl },
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`  ✅ Updated banner ${id}`);
}

async function updateCorporate(id: string, imageUrl: string): Promise<void> {
  console.log(`  Updating corporate ${id}...`);
  await axios.put(
    `${BASE_URL}/api/v1/corporates/${id}`,
    { logoUrl: imageUrl },
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`  ✅ Updated corporate ${id}`);
}

async function updatePartner(id: string, imageUrl: string): Promise<void> {
  console.log(`  Updating partner ${id}...`);
  await axios.put(
    `${BASE_URL}/api/v1/partners/${id}`,
    { logoUrl: imageUrl },
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`  ✅ Updated partner ${id}`);
}

async function updateHealthTip(id: string, imageUrl: string): Promise<void> {
  console.log(`  Updating health tip ${id}...`);
  await axios.put(
    `${BASE_URL}/api/v1/health-tips/${id}`,
    { imageUrl: imageUrl },
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`  ✅ Updated health tip ${id}`);
}

async function main() {
  try {
    // Check if images exist
    const images = [
      { name: 'Specialist', path: SPECIALIST_IMAGE },
      { name: 'Package', path: PACKAGE_IMAGE },
      { name: 'Banner', path: BANNER_IMAGE },
      { name: 'Corporate', path: CORPORATE_IMAGE },
      { name: 'Partners', path: PARTNERS_IMAGE },
      { name: 'Health Tips', path: HEALTH_TIPS_IMAGE },
    ];

    for (const img of images) {
      if (!fs.existsSync(img.path)) {
        console.error(`❌ Error: ${img.name} image not found at: ${img.path}`);
        console.log(`Please ensure the image exists or set ${img.name.toUpperCase()}_IMAGE_PATH environment variable`);
        process.exit(1);
      }
    }

    console.log('🚀 Starting image update process...\n');

    // Step 1: Upload images
    console.log('📤 Step 1: Uploading images...\n');
    const specialistImageUrl = await uploadFile(SPECIALIST_IMAGE, 'specialists');
    const packageImageUrl = await uploadFile(PACKAGE_IMAGE, 'packages');
    const bannerImageUrl = await uploadFile(BANNER_IMAGE, 'banners');
    const corporateImageUrl = await uploadFile(CORPORATE_IMAGE, 'corporates');
    const partnersImageUrl = await uploadFile(PARTNERS_IMAGE, 'partners');
    const healthTipsImageUrl = await uploadFile(HEALTH_TIPS_IMAGE, 'health-tips');

    console.log('\n📋 Step 2: Fetching existing records...\n');

    // Step 2: Get all existing records
    const specialists = await getAllSpecialists();
    const packages = await getAllWellnessPackages();
    const banners = await getAllBanners();
    const corporates = await getAllCorporates();
    const partners = await getAllPartners();
    const healthTips = await getAllHealthTips();

    console.log('\n🔄 Step 3: Updating records...\n');

    // Step 3: Update specialists
    if (specialists.length > 0) {
      console.log(`📝 Updating ${specialists.length} specialists...`);
      for (const specialist of specialists) {
        if (specialist._id) {
          await updateSpecialist(specialist._id, specialistImageUrl);
        }
      }
      console.log(`✅ All specialists updated\n`);
    } else {
      console.log('ℹ️  No specialists found to update\n');
    }

    // Step 4: Update wellness packages
    if (packages.length > 0) {
      console.log(`📝 Updating ${packages.length} wellness packages...`);
      for (const pkg of packages) {
        if (pkg._id) {
          await updateWellnessPackage(pkg._id, packageImageUrl);
        }
      }
      console.log(`✅ All wellness packages updated\n`);
    } else {
      console.log('ℹ️  No wellness packages found to update\n');
    }

    // Step 5: Update banners
    if (banners.length > 0) {
      console.log(`📝 Updating ${banners.length} banners...`);
      for (const banner of banners) {
        if (banner._id) {
          await updateBanner(banner._id, bannerImageUrl);
        }
      }
      console.log(`✅ All banners updated\n`);
    } else {
      console.log('ℹ️  No banners found to update\n');
    }

    // Step 6: Update corporates
    if (corporates.length > 0) {
      console.log(`📝 Updating ${corporates.length} corporates...`);
      for (const corporate of corporates) {
        if (corporate._id) {
          await updateCorporate(corporate._id, corporateImageUrl);
        }
      }
      console.log(`✅ All corporates updated\n`);
    } else {
      console.log('ℹ️  No corporates found to update\n');
    }

    // Step 7: Update partners
    if (partners.length > 0) {
      console.log(`📝 Updating ${partners.length} partners...`);
      for (const partner of partners) {
        if (partner._id) {
          await updatePartner(partner._id, partnersImageUrl);
        }
      }
      console.log(`✅ All partners updated\n`);
    } else {
      console.log('ℹ️  No partners found to update\n');
    }

    // Step 8: Update health tips
    if (healthTips.length > 0) {
      console.log(`📝 Updating ${healthTips.length} health tips...`);
      for (const healthTip of healthTips) {
        if (healthTip._id) {
          await updateHealthTip(healthTip._id, healthTipsImageUrl);
        }
      }
      console.log(`✅ All health tips updated\n`);
    } else {
      console.log('ℹ️  No health tips found to update\n');
    }

    console.log('🎉 Image update process completed successfully!');
    console.log(`\nSummary:`);
    console.log(`- Specialists updated: ${specialists.length}`);
    console.log(`- Wellness packages updated: ${packages.length}`);
    console.log(`- Banners updated: ${banners.length}`);
    console.log(`- Corporates updated: ${corporates.length}`);
    console.log(`- Partners updated: ${partners.length}`);
    console.log(`- Health tips updated: ${healthTips.length}`);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
