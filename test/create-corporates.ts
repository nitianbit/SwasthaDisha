import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4030';
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // Set via environment variable: AUTH_TOKEN=your_token npm run create-corporates

// Configure axios defaults to avoid CORS issues
axios.defaults.headers.common['Content-Type'] = 'application/json';
axios.defaults.headers.common['Accept'] = 'application/json';

// Create axios instance with default config
const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 30000, // 30 seconds timeout
});

const CORPORATE_IMAGE = process.env.CORPORATE_IMAGE_PATH || path.join(
  __dirname,
  'assets/corporate-7c205cc5-8be2-4ea9-86d6-70e5bf363632.png'
);

interface CorporateData {
  name: string;
  companyName?: string;
  email?: string;
  phone?: string;
  contactPerson?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  logoUrl?: string;
  website?: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  description?: string;
  isActive?: boolean;
  isVerified?: boolean;
}

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
    console.log(`⚠️  File not found: ${filePath}, skipping upload`);
    return '';
  }

  try {
    const formData = new FormData();
    formData.append('files', fs.createReadStream(filePath));
    formData.append('module', module);

    const response = await axios.post<UploadResponse>(
      `${BASE_URL}/api/v1/file/upload`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'Accept': 'application/json',
        },
      }
    );

    if (response.data.success && response.data.data.files?.[0]?.url) {
      return response.data.data.files[0].url;
    }
    return '';
  } catch (error: any) {
    if (error.response?.status === 0 || error.code === 'ECONNREFUSED') {
      console.error(`❌ Connection error: Cannot connect to ${BASE_URL}`);
      console.error(`   Make sure the server is running on ${BASE_URL}`);
    } else if (error.response?.status === 401) {
      console.error(`❌ Authentication error: Invalid or expired token`);
    } else if (error.response?.status === 403) {
      console.error(`❌ Forbidden: Check CORS configuration or authentication`);
    } else {
      console.error(`❌ Error uploading file ${filePath}:`, error.response?.data || error.message);
    }
    return '';
  }
}

async function createCorporate(corporate: CorporateData): Promise<string | null> {
  try {
    const response = await apiClient.post(
      `/api/v1/corporates`,
      corporate,
      {
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
      }
    );

    if (response.data.success && response.data.data?._id) {
      console.log(`✅ Created corporate: ${corporate.name} (ID: ${response.data.data._id})`);
      return response.data.data._id;
    } else {
      console.log(`⚠️  Corporate created but no ID returned: ${corporate.name}`);
      return null;
    }
  } catch (error: any) {
    const errorData = error.response?.data;
    if (errorData?.code === 'DOMAIN_ALREADY_EXISTS' || errorData?.message?.includes('domain already exists')) {
      console.error(`⚠️  Skipping ${corporate.name}: Domain "${corporate.domain}" already exists`);
      console.error(`   This means a corporate with domain "${corporate.domain}" is already in the database.\n`);
    } else {
      console.error(`❌ Error creating corporate ${corporate.name}:`, errorData || error.message);
    }
    return null;
  }
}

async function getAllCorporates(): Promise<any[]> {
  try {
    const response = await apiClient.get(`/api/v1/corporates`, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
    });

    if (response.data.success && response.data.data) {
      return Array.isArray(response.data.data) ? response.data.data : response.data.data.corporates || [];
    }
    return [];
  } catch (error: any) {
    console.error('❌ Error fetching corporates:', error.response?.data || error.message);
    return [];
  }
}

// Corporate data list
const CORPORATES_DATA: CorporateData[] = [
  {
    name: 'Tech Corp',
    companyName: 'Tech Corporation Pvt Ltd',
    industry: 'IT',
    email: 'info@techcorp.com',
    phone: '9876543210',
    contactPerson: 'John Manager',
    address: '789 Corporate Avenue',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400002',
    country: 'India',
    domain: 'techcorp.com',
    website: 'https://techcorp.com',
    employeeCount: 500,
    description: 'Leading IT services company providing software solutions and consulting services.',
    isActive: true,
    isVerified: true,
  },
  {
    name: 'Finance Corp',
    companyName: 'Finance Corporation Ltd',
    industry: 'Finance',
    email: 'info@financecorp.com',
    phone: '9876543211',
    contactPerson: 'Jane Director',
    address: '321 Business Park',
    city: 'Delhi',
    state: 'Delhi',
    pincode: '110001',
    country: 'India',
    domain: 'financecorp.com',
    website: 'https://financecorp.com',
    employeeCount: 300,
    description: 'Leading financial services company offering banking and investment solutions.',
    isActive: true,
    isVerified: true,
  },
  {
    name: 'Healthcare Solutions',
    companyName: 'Healthcare Solutions Inc',
    industry: 'Healthcare',
    email: 'info@healthcaresolutions.com',
    phone: '9876543212',
    contactPerson: 'Dr. Sarah Johnson',
    address: '456 Medical Plaza',
    city: 'Bangalore',
    state: 'Karnataka',
    pincode: '560001',
    country: 'India',
    domain: 'healthcaresolutions.com',
    website: 'https://healthcaresolutions.com',
    employeeCount: 750,
    description: 'Healthcare technology company providing medical software and telemedicine solutions.',
    isActive: true,
    isVerified: true,
  },
  {
    name: 'Manufacturing Industries',
    companyName: 'Manufacturing Industries Pvt Ltd',
    industry: 'Manufacturing',
    email: 'info@manufacturing.com',
    phone: '9876543213',
    contactPerson: 'Robert Kumar',
    address: '789 Industrial Area',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
    country: 'India',
    domain: 'manufacturing.com',
    website: 'https://manufacturing.com',
    employeeCount: 1200,
    description: 'Large-scale manufacturing company producing industrial equipment and machinery.',
    isActive: true,
    isVerified: true,
  },
  {
    name: 'Retail Enterprises',
    companyName: 'Retail Enterprises Ltd',
    industry: 'Retail',
    email: 'info@retailenterprises.com',
    phone: '9876543214',
    contactPerson: 'Priya Sharma',
    address: '123 Shopping District',
    city: 'Hyderabad',
    state: 'Telangana',
    pincode: '500001',
    country: 'India',
    domain: 'retailenterprises.com',
    website: 'https://retailenterprises.com',
    employeeCount: 800,
    description: 'Retail chain with multiple stores across India offering consumer goods and electronics.',
    isActive: true,
    isVerified: true,
  },
  {
    name: 'Education Services',
    companyName: 'Education Services Pvt Ltd',
    industry: 'Education',
    email: 'info@educationservices.com',
    phone: '9876543215',
    contactPerson: 'Amit Patel',
    address: '456 Education Hub',
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '380001',
    country: 'India',
    domain: 'educationservices.com',
    website: 'https://educationservices.com',
    employeeCount: 400,
    description: 'Educational services provider offering online courses and training programs.',
    isActive: true,
    isVerified: true,
  },
  {
    name: 'Real Estate Developers',
    companyName: 'Real Estate Developers Ltd',
    industry: 'Real Estate',
    email: 'info@realestatedev.com',
    phone: '9876543216',
    contactPerson: 'Vikram Singh',
    address: '789 Construction Avenue',
    city: 'Gurgaon',
    state: 'Haryana',
    pincode: '122001',
    country: 'India',
    domain: 'realestatedev.com',
    website: 'https://realestatedev.com',
    employeeCount: 600,
    description: 'Real estate development company specializing in residential and commercial projects.',
    isActive: true,
    isVerified: true,
  },
  {
    name: 'Logistics & Transport',
    companyName: 'Logistics & Transport Co',
    industry: 'Logistics',
    email: 'info@logistics.com',
    phone: '9876543217',
    contactPerson: 'Rajesh Kumar',
    address: '321 Transport Hub',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600001',
    country: 'India',
    domain: 'logistics.com',
    website: 'https://logistics.com',
    employeeCount: 900,
    description: 'Logistics and transportation company providing warehousing and distribution services.',
    isActive: true,
    isVerified: true,
  },
];

async function main() {
  console.log('🚀 Starting Corporate Creation Script...\n');
  console.log(`📡 Connecting to: ${BASE_URL}\n`);

  if (!AUTH_TOKEN) {
    console.error('❌ AUTH_TOKEN is required. Please set it as an environment variable or update the script.');
    console.log('   Usage: AUTH_TOKEN=your_token npm run create-corporates');
    console.log('   Or get a token by running: npm run test:api');
    process.exit(1);
  }

  // Test connection first
  try {
    console.log('🔍 Testing server connection...');
    const healthCheck = await apiClient.get('/health');
    console.log(`✅ Server is running: ${healthCheck.status === 200 ? 'OK' : 'Unknown status'}\n`);
  } catch (error: any) {
    if (error.code === 'ECONNREFUSED' || error.response?.status === 0) {
      console.error(`❌ Cannot connect to server at ${BASE_URL}`);
      console.error('   Please make sure the server is running:');
      console.error('   npm run dev');
      process.exit(1);
    } else {
      console.log(`⚠️  Health check failed, but continuing... (${error.message})\n`);
    }
  }

  // Upload corporate logo if available
  let corporateLogoUrl = '';
  if (fs.existsSync(CORPORATE_IMAGE)) {
    console.log('📤 Uploading corporate logo...');
    corporateLogoUrl = await uploadFile(CORPORATE_IMAGE, 'corporates');
    if (corporateLogoUrl) {
      console.log(`✅ Logo uploaded: ${corporateLogoUrl}\n`);
    } else {
      console.log('⚠️  Logo upload failed, continuing without logo\n');
    }
  } else {
    console.log(`⚠️  Corporate image not found at ${CORPORATE_IMAGE}, continuing without logo\n`);
  }

  // Check existing corporates
  console.log('📋 Checking existing corporates...');
  const existingCorporates = await getAllCorporates();
  console.log(`   Found ${existingCorporates.length} existing corporate(s)\n`);

  // Create corporates
  console.log(`📝 Creating ${CORPORATES_DATA.length} corporate(s)...\n`);
  const createdIds: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < CORPORATES_DATA.length; i++) {
    const corporate = CORPORATES_DATA[i];
    
    // Add logo URL if available
    if (corporateLogoUrl && !corporate.logoUrl) {
      corporate.logoUrl = corporateLogoUrl;
    }

    // Generate unique phone number if not provided
    if (!corporate.phone) {
      const timestamp = Date.now() + i;
      const phoneSuffix = timestamp.toString().slice(-8).padStart(8, '0');
      corporate.phone = `98${phoneSuffix}`;
    }

    // Generate unique email if not provided
    if (!corporate.email) {
      const timestamp = Date.now() + i;
      corporate.email = `info.${timestamp}@${corporate.domain || 'corporate.com'}`;
    }

    const corporateId = await createCorporate(corporate);
    if (corporateId) {
      createdIds.push(corporateId);
    } else {
      failed.push(corporate.name);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 Summary:');
  console.log('='.repeat(60));
  console.log(`✅ Successfully created: ${createdIds.length} corporate(s)`);
  if (failed.length > 0) {
    console.log(`❌ Failed to create: ${failed.length} corporate(s)`);
    console.log(`   Failed: ${failed.join(', ')}`);
  }
  console.log('='.repeat(60));

  // Final count
  const finalCorporates = await getAllCorporates();
  console.log(`\n📈 Total corporates in database: ${finalCorporates.length}`);
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
