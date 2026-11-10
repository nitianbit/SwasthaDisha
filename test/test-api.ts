import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4030';
const RESULTS_FILE = path.join(__dirname, 'api-test-results.json');

// Image paths
const SPECIALIST_IMAGE = path.join(__dirname, 'assets/specialist-fd6fd7d9-85ae-49ff-86fa-ad5269185d9c.png');
const PACKAGE_IMAGE = path.join(__dirname, 'assets/package1-eb1aeba9-a4e2-4682-ac36-97c00b93e355.png');
const BANNER_IMAGE = path.join(__dirname, 'assets/banner-e185cd78-4636-4533-b0cb-cb4590e570a3.png');
const CORPORATE_IMAGE = path.join(__dirname, 'assets/corporate-7c205cc5-8be2-4ea9-86d6-70e5bf363632.png');
const PARTNERS_IMAGE = path.join(__dirname, 'assets/partners-dc98b66b-d8b7-4356-a62f-5cd1c882b7ee.png');
const HEALTH_TIPS_IMAGE = path.join(__dirname, 'assets/health-tips-9470bfcb-56da-4965-b521-82b442ccfbe9.png');

let specialistImageUrl: string | null = null;
let packageImageUrl: string | null = null;
let bannerImageUrl: string | null = null;
let corporateImageUrl: string | null = null;
let partnersImageUrl: string | null = null;
let healthTipsImageUrl: string | null = null;

interface TestError {
  message: string;
  code?: string | null;
  statusCode: number | string;
  response: any;
  fullError: string;
}

interface TestResult {
  name: string;
  method: string;
  url: string;
  request?: any;
  timestamp: string;
  status: 'pending' | 'success' | 'error' | 'skipped';
  requiresAuth?: boolean;
  authUsed?: boolean;
  tokenSaved?: boolean;
  statusCode?: number | string;
  response?: any;
  error?: TestError;
  message?: string;
}

interface TestResults {
  timestamp: string;
  baseUrl: string;
  authToken: string | null;
  tests: TestResult[];
}

const results: TestResults = {
  timestamp: new Date().toISOString(),
  baseUrl: BASE_URL,
  authToken: null,
  tests: [],
};

let userId: string | null = null;
let specialistId: string | null = null;
let wellnessPackageId: string | null = null;
let partnerId: string | null = null;
let corporateId: string | null = null;
let dependentId: string | null = null;
let slotId: string | null = null;
let walletId: string | null = null;
let couponId: string | null = null;
let notificationId: string | null = null;
let bookingId: string | null = null;
let transactionId: string | null = null;
let healthTipId: string | null = null;
let hrId: string | null = null;
let employeeId: string | null = null;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

// Helper function to make API calls
async function testAPI(
  name: string,
  method: HttpMethod,
  url: string,
  data: any = null,
  headers: Record<string, string> = {},
  requiresAuth: boolean = false
): Promise<TestResult> {
  const testResult: TestResult = {
    name,
    method,
    url,
    request: data,
    timestamp: new Date().toISOString(),
    status: 'pending',
    requiresAuth,
  };

  try {
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    // Add auth token if required and available
    if (requiresAuth && results.authToken) {
      requestHeaders['Authorization'] = `Bearer ${results.authToken}`;
      testResult.authUsed = true;
    } else if (requiresAuth && !results.authToken) {
      testResult.status = 'skipped';
      testResult.message = 'Skipped - No auth token available';
      console.log(`⏭️  ${name}: Skipped (no auth token)`);
      results.tests.push(testResult);
      return testResult;
    }

    const config: AxiosRequestConfig = {
      method,
      url: `${BASE_URL}${url}`,
      headers: requestHeaders,
    };

    if (data && (method === 'POST' || method === 'PUT')) {
      config.data = data;
    }

    const response: AxiosResponse = await axios(config);
    testResult.status = 'success';
    testResult.statusCode = response.status;
    testResult.response = response.data;
    
    // Extract token and userId from auth responses (check multiple possible locations)
    if (name.includes('Verify OTP') || name.includes('OTP - Verify')) {
      const token = 
        (response.data as any)?.data?.token || 
        (response.data as any)?.data?.accessToken ||
        (response.data as any)?.token || 
        (response.data as any)?.accessToken;
      if (token) {
        results.authToken = token;
        testResult.tokenSaved = true;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 🔑 Token saved: ${token.substring(0, 20)}...`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - ⚠️  No token in response`);
        console.log(`   Response structure:`, JSON.stringify(response.data, null, 2).substring(0, 200));
      }
      
      // Extract userId from OTP verify response
      const userData = (response.data as any)?.data?.user;
      if (userData?._id) {
        userId = userData._id;
        console.log(`   👤 User ID extracted: ${userId}`);
      }
    } else if (name.includes('Get Profile') || name.includes('Profile - Get')) {
      // Extract userId from profile response
      const userData = (response.data as any)?.data?.user;
      if (userData?._id) {
        userId = userData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 👤 User ID: ${userId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Specialists - Create')) {
      // Extract specialistId from create response
      const specialistData = (response.data as any)?.data;
      if (specialistData?._id) {
        specialistId = specialistData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 👨‍⚕️ Specialist ID: ${specialistId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Wellness Packages - Create')) {
      // Extract wellnessPackageId from create response
      const packageData = (response.data as any)?.data;
      if (packageData?._id) {
        wellnessPackageId = packageData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 📦 Package ID: ${wellnessPackageId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Partners - Create')) {
      // Extract partnerId from create response
      const partnerData = (response.data as any)?.data;
      if (partnerData?._id) {
        partnerId = partnerData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 🤝 Partner ID: ${partnerId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Corporates - Create')) {
      // Extract corporateId from create response
      const corporateData = (response.data as any)?.data;
      if (corporateData?._id) {
        corporateId = corporateData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 🏢 Corporate ID: ${corporateId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Dependents - Create')) {
      // Extract dependentId from create response
      const dependentData = (response.data as any)?.data;
      if (dependentData?._id) {
        dependentId = dependentData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 👨‍👩‍👧 Dependent ID: ${dependentId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Slots - Create')) {
      // Extract slotId from create response
      const slotData = (response.data as any)?.data;
      if (slotData?._id) {
        slotId = slotData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - ⏰ Slot ID: ${slotId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Bookings - Create')) {
      // Extract bookingId from create response
      const bookingData = (response.data as any)?.data;
      if (bookingData?._id) {
        bookingId = bookingData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 📅 Booking ID: ${bookingId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Wallet - Get by User ID')) {
      // Extract walletId from wallet response
      const walletData = (response.data as any)?.data;
      if (walletData?._id) {
        walletId = walletData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 💰 Wallet ID: ${walletId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Wallet - Add Credit Transaction')) {
      // Extract transactionId from transaction response
      const transactionData = (response.data as any)?.data;
      if (transactionData?._id) {
        transactionId = transactionData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 💳 Transaction ID: ${transactionId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Coupons - Create')) {
      // Extract couponId and couponCode from create response
      const couponData = (response.data as any)?.data;
      if (couponData?._id) {
        couponId = couponData._id;
        if (couponData?.code) {
          // Store coupon code for use in bookings
          (global as any).couponCode = couponData.code;
        }
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 🎫 Coupon ID: ${couponId}, Code: ${couponData?.code || 'N/A'}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('HR - Create')) {
      // Extract hrId and employeeId from create response
      const hrData = (response.data as any)?.data;
      if (hrData?._id) {
        hrId = hrData._id;
        if (hrData?.employeeId) {
          employeeId = hrData.employeeId;
        }
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 👤 HR ID: ${hrId}, Employee ID: ${employeeId || 'N/A'}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Notifications - Get by User ID')) {
      // Extract notificationId from notifications response
      const notificationsData = (response.data as any)?.data;
      if (Array.isArray(notificationsData) && notificationsData[0]?._id) {
        notificationId = notificationsData[0]._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 🔔 Notification ID: ${notificationId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else if (name.includes('Health Tips - Create')) {
      // Extract healthTipId from create response
      const healthTipData = (response.data as any)?.data;
      if (healthTipData?._id) {
        healthTipId = healthTipData._id;
        console.log(`✅ ${name}: ${response.status} ${response.statusText} - 💡 Health Tip ID: ${healthTipId}`);
      } else {
        console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
      }
    } else {
      console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    testResult.status = 'error';
    const axiosError = error as AxiosError;
    testResult.statusCode = axiosError.response?.status || 'N/A';
    const errorResponse = axiosError.response?.data || null;
    const errorMessage = 
      (errorResponse as any)?.message || 
      (errorResponse as any)?.error?.message || 
      axiosError.message;
    const errorCode = 
      (errorResponse as any)?.code || 
      (errorResponse as any)?.error?.code || 
      null;
    
    testResult.error = {
      message: errorMessage,
      code: errorCode,
      statusCode: testResult.statusCode,
      response: errorResponse,
      fullError: axiosError.message,
    };
    
    // Display detailed error message
    console.log(`❌ ${name}: ${testResult.statusCode} - ${errorMessage}`);
    if (errorCode) {
      console.log(`   Code: ${errorCode}`);
    }
    if (errorResponse && typeof errorResponse === 'object') {
      const details = JSON.stringify(errorResponse, null, 2);
      if (details.length < 200) {
        console.log(`   Details: ${details}`);
      } else {
        console.log(`   Details: ${details.substring(0, 200)}...`);
      }
    }
  }

  results.tests.push(testResult);
  return testResult;
}

// Test file upload
async function testFileUpload(
  name: string,
  url: string,
  filePath: string,
  module?: string
): Promise<TestResult> {
  const testResult: TestResult = {
    name,
    method: 'POST',
    url,
    timestamp: new Date().toISOString(),
    status: 'pending',
    requiresAuth: true,
  };

  try {
    if (!fs.existsSync(filePath)) {
      testResult.status = 'skipped';
      testResult.message = `File not found: ${filePath}`;
      console.log(`⏭️  ${name}: Skipped (file not found)`);
      results.tests.push(testResult);
      return testResult;
    }

    if (!results.authToken) {
      testResult.status = 'skipped';
      testResult.message = 'Skipped - No auth token available';
      console.log(`⏭️  ${name}: Skipped (no auth token)`);
      results.tests.push(testResult);
      return testResult;
    }

    const formData = new FormData();
    formData.append('files', fs.createReadStream(filePath));
    if (module) {
      formData.append('module', module);
    }

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: `${BASE_URL}${url}`,
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${results.authToken}`,
      },
      data: formData,
    };

    const response = await axios(config);
    testResult.status = 'success';
    testResult.statusCode = response.status;
    testResult.response = response.data;
    testResult.authUsed = true;

    // Extract image URL from response
    if (response.data.success && response.data.data?.files?.length > 0) {
      const imageUrl = response.data.data.files[0].url;
      console.log(`✅ ${name}: ${response.status} ${response.statusText} - 📷 Image URL: ${imageUrl}`);
    } else {
      console.log(`✅ ${name}: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    testResult.status = 'error';
    const axiosError = error as AxiosError;
    testResult.statusCode = axiosError.response?.status || 'N/A';
    const errorResponse = axiosError.response?.data || null;
    const errorMessage =
      (errorResponse as any)?.message ||
      (errorResponse as any)?.error?.message ||
      axiosError.message;
    const errorCode =
      (errorResponse as any)?.code ||
      (errorResponse as any)?.error?.code ||
      null;

    testResult.error = {
      message: errorMessage,
      code: errorCode,
      statusCode: testResult.statusCode,
      response: errorResponse,
      fullError: axiosError.message,
    };

    console.log(`❌ ${name}: ${testResult.statusCode} - ${errorMessage}`);
    if (errorCode) {
      console.log(`   Code: ${errorCode}`);
    }
  }

  results.tests.push(testResult);
  return testResult;
}

// Main test function
async function runTests(): Promise<void> {
  console.log(`\n🚀 Starting API Tests against ${BASE_URL}\n`);
  console.log('='.repeat(60));

  // ============================================
  // 1. HEALTH CHECK
  // ============================================
  await testAPI('Health Check', 'GET', '/health');

  // ============================================
  // 2. OTP - SEND
  // ============================================
  await testAPI(
    'OTP - Send (Phone)',
    'POST',
    '/api/v1/auth/user/send',
    { phone: '9876543210' }
  );

  // Wait a moment for OTP to be generated
  await new Promise(resolve => setTimeout(resolve, 1000));

  // ============================================
  // 3. OTP - VERIFY
  // ============================================
  const verifyOTPResult = await testAPI(
    'OTP - Verify',
    'POST',
    '/api/v1/auth/user/verify',
    { phone: '9876543210', otp: '123456' }
  );

  // Log token status
  if (results.authToken) {
    console.log(`\n🔑 Authentication token obtained: ${results.authToken.substring(0, 20)}...`);
    console.log('   Using token for subsequent authenticated requests\n');
  } else {
    console.log('\n⚠️  No authentication token available. Some endpoints may require authentication.\n');
  }

  // ============================================
  // 4. UPLOAD IMAGES
  // ============================================
  console.log('\n📤 Uploading test images...\n');
  
  const specialistUploadResult = await testFileUpload(
    'File Upload - Specialist Image',
    '/api/v1/file/upload',
    SPECIALIST_IMAGE,
    'specialists'
  );
  if (specialistUploadResult.status === 'success' && specialistUploadResult.response?.data?.files?.[0]?.url) {
    specialistImageUrl = specialistUploadResult.response.data.files[0].url;
    console.log(`✅ Specialist image uploaded: ${specialistImageUrl}\n`);
  }

  const packageUploadResult = await testFileUpload(
    'File Upload - Package Image',
    '/api/v1/file/upload',
    PACKAGE_IMAGE,
    'packages'
  );
  if (packageUploadResult.status === 'success' && packageUploadResult.response?.data?.files?.[0]?.url) {
    packageImageUrl = packageUploadResult.response.data.files[0].url;
    console.log(`✅ Package image uploaded: ${packageImageUrl}\n`);
  }

  const bannerUploadResult = await testFileUpload(
    'File Upload - Banner Image',
    '/api/v1/file/upload',
    BANNER_IMAGE,
    'banners'
  );
  if (bannerUploadResult.status === 'success' && bannerUploadResult.response?.data?.files?.[0]?.url) {
    bannerImageUrl = bannerUploadResult.response.data.files[0].url;
    console.log(`✅ Banner image uploaded: ${bannerImageUrl}\n`);
  }

  const corporateUploadResult = await testFileUpload(
    'File Upload - Corporate Image',
    '/api/v1/file/upload',
    CORPORATE_IMAGE,
    'corporates'
  );
  if (corporateUploadResult.status === 'success' && corporateUploadResult.response?.data?.files?.[0]?.url) {
    corporateImageUrl = corporateUploadResult.response.data.files[0].url;
    console.log(`✅ Corporate image uploaded: ${corporateImageUrl}\n`);
  }

  const partnersUploadResult = await testFileUpload(
    'File Upload - Partners Image',
    '/api/v1/file/upload',
    PARTNERS_IMAGE,
    'partners'
  );
  if (partnersUploadResult.status === 'success' && partnersUploadResult.response?.data?.files?.[0]?.url) {
    partnersImageUrl = partnersUploadResult.response.data.files[0].url;
    console.log(`✅ Partners image uploaded: ${partnersImageUrl}\n`);
  }

  const healthTipsUploadResult = await testFileUpload(
    'File Upload - Health Tips Image',
    '/api/v1/file/upload',
    HEALTH_TIPS_IMAGE,
    'health-tips'
  );
  if (healthTipsUploadResult.status === 'success' && healthTipsUploadResult.response?.data?.files?.[0]?.url) {
    healthTipsImageUrl = healthTipsUploadResult.response.data.files[0].url;
    console.log(`✅ Health Tips image uploaded: ${healthTipsImageUrl}\n`);
  }

  // ============================================
  // 5. PROFILE - GET
  // ============================================
  await testAPI('Profile - Get', 'GET', '/api/v1/auth/profile', null, {}, true);

  // ============================================
  // 6. PROFILE - UPDATE
  // ============================================
  if (userId) {
    await testAPI(
      'Profile - Update',
      'PUT',
      `/api/v1/users/${userId}`,
      {
        name: 'Updated Test User',
        city: 'Mumbai',
        state: 'Maharashtra',
      },
      {},
      true
    );
  } else {
    console.log('⚠️  Skipping Profile Update - No userId available');
  }

  // ============================================
  // 7. CREATE PACKAGES (with good test data)
  // ============================================
  await testAPI(
    'Wellness Packages - Create',
    'POST',
    '/api/v1/wellness-packages',
    {
      name: 'Complete Health Checkup',
      description: 'Comprehensive health checkup package covering all major health parameters. Includes blood tests, imaging, and doctor consultation.',
      bookingProcedure: 'Fast for 12 hours before the test. Book your slot online and visit our center.',
      imageUrl: packageImageUrl || '/api/static/packages/default-package.jpg',
      category: 'diagnostics',
      originalPrice: 3999,
      discountedPrice: 2999,
      testsIncluded: [
        {
          categoryName: 'Blood Tests',
          categoryTestsCount: 5,
          subTests: ['CBC', 'Lipid Profile', 'Blood Sugar', 'Liver Function', 'Kidney Function'],
        },
        {
          categoryName: 'Imaging',
          categoryTestsCount: 2,
          subTests: ['ECG', 'X-Ray'],
        },
      ],
      totalTestsCount: 7,
      hasFreeDoctorConsultation: true,
      isActive: true,
      isPopular: true,
      order: 1,
    },
    {},
    true
  );

  // Create more wellness packages
  await testAPI(
    'Wellness Packages - Create (Premium)',
    'POST',
    '/api/v1/wellness-packages',
    {
      name: 'Premium Executive Health Checkup',
      description: 'Advanced health screening for executives with comprehensive tests and personalized consultation.',
      imageUrl: packageImageUrl || '/api/static/packages/default-package.jpg',
      category: 'executive',
      originalPrice: 8999,
      discountedPrice: 6999,
      testsIncluded: [
        {
          categoryName: 'Advanced Blood Tests',
          categoryTestsCount: 8,
          subTests: ['Complete Blood Count', 'Lipid Profile', 'HbA1c', 'Thyroid Function', 'Vitamin D', 'B12', 'Liver Function', 'Kidney Function'],
        },
        {
          categoryName: 'Cardiac Tests',
          categoryTestsCount: 2,
          subTests: ['ECG', 'Echocardiogram'],
        },
        {
          categoryName: 'Imaging',
          categoryTestsCount: 3,
          subTests: ['Chest X-Ray', 'Ultrasound Abdomen', 'Bone Density'],
        },
      ],
      totalTestsCount: 13,
      hasFreeDoctorConsultation: true,
      isActive: true,
      isPopular: true,
      order: 2,
    },
    {},
    true
  );

  await testAPI(
    'Wellness Packages - Create (Women)',
    'POST',
    '/api/v1/wellness-packages',
    {
      name: 'Women\'s Health Package',
      description: 'Comprehensive health checkup designed specifically for women\'s health needs.',
      imageUrl: packageImageUrl || '/api/static/packages/default-package.jpg',
      category: 'women',
      originalPrice: 4999,
      discountedPrice: 3499,
      testsIncluded: [
        {
          categoryName: 'Blood Tests',
          categoryTestsCount: 6,
          subTests: ['CBC', 'Lipid Profile', 'Blood Sugar', 'Thyroid Function', 'Vitamin D', 'Iron Studies'],
        },
        {
          categoryName: 'Women Specific',
          categoryTestsCount: 2,
          subTests: ['Pap Smear', 'Mammography'],
        },
      ],
      totalTestsCount: 8,
      hasFreeDoctorConsultation: true,
      isActive: true,
      isPopular: false,
      order: 3,
    },
    {},
    true
  );

  // ============================================
  // 8. CREATE DOCTORS/SPECIALISTS (with good test data)
  // ============================================
  // Use timestamp to make email and phone unique to avoid conflicts on multiple test runs
  const timestamp = Date.now();
  // Generate a 10-digit phone number: 98 + last 8 digits of timestamp
  const phoneSuffix = timestamp.toString().slice(-8).padStart(8, '0');
  const uniquePhone = `98${phoneSuffix}`;
  await testAPI(
    'Specialists - Create',
    'POST',
    '/api/v1/specialists',
    {
      name: 'Dr. John Doe',
      specialization: 'Cardiologist',
      qualification: 'MBBS, MD (Cardiology), DM (Cardiology)',
      profilePictureUrl: specialistImageUrl || '/api/static/specialists/default-specialist.jpg',
      experience: 15,
      hospital: 'City Hospital',
      city: 'Mumbai',
      state: 'Maharashtra',
      phone: uniquePhone, // 10-digit unique phone
      email: `dr.john.${timestamp}@example.com`, // Unique email with timestamp
      isVerified: true,
      rating: 4.8,
      consultationFee: 1500,
      isConsultationFree: false,
      bio: 'Experienced cardiologist with expertise in preventive cardiology and interventional procedures.',
      isActive: true,
    },
    {},
    true
  );

  // Create more specialists
  const timestamp2 = Date.now() + 1;
  const phoneSuffix2 = timestamp2.toString().slice(-8).padStart(8, '0');
  const uniquePhone2 = `98${phoneSuffix2}`;
  await testAPI(
    'Specialists - Create (Dermatologist)',
    'POST',
    '/api/v1/specialists',
    {
      name: 'Dr. Sarah Smith',
      specialization: 'Dermatologist',
      qualification: 'MBBS, MD (Dermatology)',
      profilePictureUrl: specialistImageUrl || '/api/static/specialists/default-specialist.jpg',
      experience: 12,
      hospital: 'Skin Care Clinic',
      city: 'Mumbai',
      state: 'Maharashtra',
      phone: uniquePhone2,
      email: `dr.sarah.${timestamp2}@example.com`,
      isVerified: true,
      rating: 4.6,
      consultationFee: 1200,
      isConsultationFree: false,
      bio: 'Expert in treating skin conditions, hair problems, and cosmetic dermatology.',
      isActive: true,
    },
    {},
    true
  );

  const timestamp3 = Date.now() + 2;
  const phoneSuffix3 = timestamp3.toString().slice(-8).padStart(8, '0');
  const uniquePhone3 = `98${phoneSuffix3}`;
  await testAPI(
    'Specialists - Create (Pediatrician)',
    'POST',
    '/api/v1/specialists',
    {
      name: 'Dr. Priya Sharma',
      specialization: 'Pediatrician',
      qualification: 'MBBS, MD (Pediatrics)',
      profilePictureUrl: specialistImageUrl || '/api/static/specialists/default-specialist.jpg',
      experience: 10,
      hospital: 'Children\'s Hospital',
      city: 'Mumbai',
      state: 'Maharashtra',
      phone: uniquePhone3,
      email: `dr.priya.${timestamp3}@example.com`,
      isVerified: true,
      rating: 4.9,
      consultationFee: 1000,
      isConsultationFree: false,
      bio: 'Dedicated pediatrician with expertise in child health, development, and preventive care.',
      isActive: true,
    },
    {},
    true
  );

  // ============================================
  // 8. CREATE COUPONS (before bookings so they can be used)
  // ============================================
  // Create coupon for use in bookings
  const couponCode = `WELCOME${Date.now().toString().slice(-6)}`;
  const couponResult = await testAPI(
    'Coupons - Create (for Bookings)',
    'POST',
    '/api/v1/coupons',
    {
      code: couponCode,
      title: 'Welcome Discount',
      description: 'Get 20% off on your first booking',
      discountType: 'percentage',
      discountValue: 20,
      minimumPurchaseAmount: 500,
      maximumDiscountAmount: 1000,
      applicableTo: 'all',
      startDate: '20250101', // YYYYMMDD format
      endDate: '20251231', // YYYYMMDD format
      usageLimitPerUser: 1,
      totalUsageLimit: 1000,
      isActive: true,
    },
    {},
    true
  );
  if (couponResult.status === 'success' && couponResult.response?.data?._id) {
    couponId = couponResult.response.data._id;
    if (couponResult.response.data.code) {
      (global as any).couponCode = couponResult.response.data.code;
    }
  }

  // Create another coupon specifically for wellness packages
  await testAPI(
    'Coupons - Create (Wellness Package)',
    'POST',
    '/api/v1/coupons',
    {
      code: `PACKAGE${Date.now().toString().slice(-6)}`,
      title: 'Package Discount',
      description: 'Get ₹500 off on wellness packages',
      discountType: 'fixed',
      discountValue: 500,
      minimumPurchaseAmount: 2000,
      applicableTo: 'wellnessPackage',
      startDate: '20250101',
      endDate: '20251231',
      isActive: true,
    },
    {},
    true
  );

  // ============================================
  // 9. CREATE BOOKING (from userId) - with contact numbers and coupon
  // ============================================
  if (userId && specialistId) {
    // Get future date for booking (at least tomorrow)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const bookingDate = tomorrow.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD format
    
    await testAPI(
      'Bookings - Create Specialist Booking',
      'POST',
      '/api/v1/bookings/specialist',
      {
        userId: userId,
        specialistId: specialistId,
        primaryConcern: 'Regular health checkup and consultation',
        consultationMode: 'in-person',
        bookingDate: bookingDate,
        bookingTime: '10:00 AM',
        contactNo: '9876543210',
        alternateContactNo: '9876543211',
        couponCode: (global as any).couponCode || undefined,
        serviceAddress: {
          addressLine: '123 Test Street, Andheri West',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400053',
        },
        notes: 'Test booking from API test suite. Please confirm via call.',
      },
      {},
      true
    );
  } else {
    console.log('⚠️  Skipping Booking Creation - No userId or specialistId available');
  }

  // Create wellness package booking
  if (userId && wellnessPackageId) {
    const dayAfterTomorrow = new Date();
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
    const packageBookingDate = dayAfterTomorrow.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD format
    
    await testAPI(
      'Bookings - Create Package Booking',
      'POST',
      '/api/v1/bookings/wellness-package',
      {
        userId: userId,
        wellnessPackageId: wellnessPackageId,
        bookingDate: packageBookingDate,
        bookingTime: '09:00 AM',
        serviceMode: 'in-person',
        contactNo: '9876543210',
        alternateContactNo: '9876543211',
        couponCode: (global as any).couponCode || undefined,
        serviceAddress: {
          addressLine: '456 Health Center Road, Bandra',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400050',
        },
        notes: 'Wellness package booking for complete health checkup',
      },
      {},
      true
    );
  }
  
  // Create wellness package booking with coupon (if coupon exists)
  if (userId && wellnessPackageId && couponId) {
    const threeDaysLater = new Date();
    threeDaysLater.setDate(threeDaysLater.getDate() + 3);
    const couponBookingDate = threeDaysLater.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD format
    
    await testAPI(
      'Bookings - Create Package Booking with Coupon',
      'POST',
      '/api/v1/bookings/wellness-package',
      {
        userId: userId,
        wellnessPackageId: wellnessPackageId,
        bookingDate: couponBookingDate,
        bookingTime: '11:00 AM',
        serviceMode: 'in-person',
        contactNo: '9876543210',
        alternateContactNo: '9876543211',
        couponCode: (global as any).couponCode || `WELCOME${Date.now().toString().slice(-6)}`,
        serviceAddress: {
          addressLine: '789 Wellness Center, Powai',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400076',
        },
        notes: 'Wellness package booking with coupon discount',
      },
      {},
      true
    );
  }

  // ============================================
  // 10. FETCH PACKAGES
  // ============================================
  await testAPI('Wellness Packages - Get All', 'GET', '/api/v1/wellness-packages', null, {}, true);
  await testAPI(
    'Wellness Packages - Get All (Filtered)',
    'GET',
    '/api/v1/wellness-packages?isActive=true&isPopular=true&page=1&limit=10',
    null,
    {},
    true
  );
  
  // Get package by ID
  if (wellnessPackageId) {
    await testAPI(
      'Wellness Packages - Get by ID',
      'GET',
      `/api/v1/wellness-packages/${wellnessPackageId}`,
      null,
      {},
      true
    );
  }

  // ============================================
  // 11. FETCH DOCTORS/SPECIALISTS
  // ============================================
  await testAPI('Specialists - Get All', 'GET', '/api/v1/specialists', null, {}, true);
  await testAPI('Specialists - Get Verified', 'GET', '/api/v1/specialists/verified', null, {}, true);
  await testAPI(
    'Specialists - Get by Specialization',
    'GET',
    '/api/v1/specialists/specialization/Cardiologist',
    null,
    {},
    true
  );
  
  // Get specialist by ID
  if (specialistId) {
    await testAPI(
      'Specialists - Get by ID',
      'GET',
      `/api/v1/specialists/${specialistId}`,
      null,
      {},
      true
    );
  }

  // ============================================
  // 12. FETCH BOOKINGS FOR USER
  // ============================================
  if (userId) {
    await testAPI(
      'Bookings - Get by User ID',
      'GET',
      `/api/v1/bookings/user/${userId}`,
      null,
      {},
      true
    );
  }
  await testAPI('Bookings - Get All', 'GET', '/api/v1/bookings', null, {}, true);
  await testAPI('Bookings - Get Upcoming', 'GET', '/api/v1/bookings/upcoming', null, {}, true);
  
  // Get booking by ID
  if (bookingId) {
    await testAPI(
      'Bookings - Get by ID',
      'GET',
      `/api/v1/bookings/${bookingId}`,
      null,
      {},
      true
    );
  }

  // ============================================
  // 13. CREATE HEALTH TIPS (with good test data)
  // ============================================
  await testAPI(
    'Health Tips - Create',
    'POST',
    '/api/v1/health-tips',
    {
      title: 'Daily Exercise Benefits',
      description: 'Regular exercise helps maintain good health and prevents various diseases. It improves cardiovascular health, strengthens muscles, and boosts mental well-being. Aim for at least 30 minutes of moderate exercise daily.',
      shortDescription: 'Regular exercise improves overall health and well-being',
      imageUrl: healthTipsImageUrl || '/api/static/health-tips/exercise.jpg',
      category: 'wellness',
      isActive: true,
    },
    {},
    true
  );

  // Create more health tips
  await testAPI(
    'Health Tips - Create (Nutrition)',
    'POST',
    '/api/v1/health-tips',
    {
      title: 'Balanced Diet Essentials',
      description: 'A balanced diet includes fruits, vegetables, whole grains, lean proteins, and healthy fats. Avoid processed foods and maintain portion control. Stay hydrated by drinking at least 8 glasses of water daily.',
      shortDescription: 'Maintain a balanced diet for optimal health',
      imageUrl: healthTipsImageUrl || '/api/static/health-tips/nutrition.jpg',
      category: 'nutrition',
      isActive: true,
    },
    {},
    true
  );

  await testAPI(
    'Health Tips - Create (Sleep)',
    'POST',
    '/api/v1/health-tips',
    {
      title: 'Importance of Quality Sleep',
      description: 'Getting 7-9 hours of quality sleep is essential for physical and mental health. Maintain a regular sleep schedule, create a comfortable sleep environment, and avoid screens before bedtime.',
      shortDescription: 'Quality sleep is crucial for overall health',
      imageUrl: healthTipsImageUrl || '/api/static/health-tips/sleep.jpg',
      category: 'wellness',
      isActive: true,
    },
    {},
    true
  );

  await testAPI(
    'Health Tips - Create (Mental Health)',
    'POST',
    '/api/v1/health-tips',
    {
      title: 'Mental Health Awareness',
      description: 'Mental health is as important as physical health. Practice mindfulness, meditation, and stress management techniques. Don\'t hesitate to seek professional help when needed.',
      shortDescription: 'Take care of your mental health',
      imageUrl: healthTipsImageUrl || '/api/static/health-tips/mental-health.jpg',
      category: 'mental-health',
      isActive: true,
    },
    {},
    true
  );

  // ============================================
  // 14. FETCH HEALTH TIPS
  // ============================================
  await testAPI('Health Tips - Get All', 'GET', '/api/v1/health-tips', null, {}, true);
  await testAPI('Health Tips - Get Active', 'GET', '/api/v1/health-tips/active', null, {}, true);
  await testAPI(
    'Health Tips - Get by Category',
    'GET',
    '/api/v1/health-tips/category/wellness',
    null,
    {},
    true
  );
  
  // Note: Health tip ID extraction would need to be added if we want to test GET by ID

  // ============================================
  // 15. DEPENDENTS CRUD
  // ============================================
  if (userId) {
    // Create Dependent
    await testAPI(
      'Dependents - Create',
      'POST',
      '/api/v1/dependents',
      {
        userId: userId,
        name: 'John Doe Jr',
        relationship: 'Son',
        age: 25,
        gender: 'Male',
        phone: '9876543212',
        email: 'johndoejr@example.com',
        dateOfBirth: '19990115', // YYYYMMDD format
        bloodGroup: 'O+',
        address: '123 Test Street, Mumbai',
        isActive: true,
      },
      {},
      true
    );
  }

  // Get Dependents
  await testAPI('Dependents - Get All', 'GET', '/api/v1/dependents', null, {}, true);
  if (userId) {
    await testAPI(
      'Dependents - Get by User ID',
      'GET',
      `/api/v1/dependents/user/${userId}`,
      null,
      {},
      true
    );
  }

  // Update Dependent
  if (dependentId && userId) {
    await testAPI(
      'Dependents - Update',
      'PUT',
      `/api/v1/dependents/${dependentId}?userId=${userId}`,
      {
        name: 'John Doe Jr Updated',
        age: 26,
      },
      {},
      true
    );
  }

  // ============================================
  // 16. PARTNERS CRUD (with good test data)
  // ============================================
  // Create Partner
  const partnerTimestamp = Date.now();
  const partnerPhoneSuffix = partnerTimestamp.toString().slice(-8).padStart(8, '0');
  const uniquePartnerPhone = `98${partnerPhoneSuffix}`;
  await testAPI(
    'Partners - Create',
    'POST',
    '/api/v1/partners',
    {
      name: 'City Hospital',
      partnerType: 'hospital',
      description: 'A leading multi-specialty healthcare facility providing comprehensive medical services with state-of-the-art infrastructure and experienced medical professionals.',
      email: `info.${partnerTimestamp}@cityhospital.com`,
      phone: uniquePartnerPhone,
      address: '456 Hospital Road, Andheri',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400053',
      website: 'https://cityhospital.com',
      logoUrl: partnersImageUrl || corporateImageUrl || '/api/static/partners/city-hospital-logo.png',
      isActive: true,
      isVerified: true,
    },
    {},
    true
  );

  // Create more partners
  const partnerTimestamp2 = Date.now() + 1;
  const partnerPhoneSuffix2 = partnerTimestamp2.toString().slice(-8).padStart(8, '0');
  const uniquePartnerPhone2 = `98${partnerPhoneSuffix2}`;
  await testAPI(
    'Partners - Create (Lab)',
    'POST',
    '/api/v1/partners',
    {
      name: 'Diagnostic Lab Center',
      partnerType: 'lab',
      description: 'Advanced diagnostic laboratory with modern equipment and accurate test results.',
      email: `info.${partnerTimestamp2}@diagnosticlab.com`,
      phone: uniquePartnerPhone2,
      address: '789 Medical Complex, Bandra',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400050',
      website: 'https://diagnosticlab.com',
      logoUrl: partnersImageUrl || corporateImageUrl || '/api/static/partners/diagnostic-lab-logo.png',
      isActive: true,
      isVerified: true,
    },
    {},
    true
  );

  // Get Partners
  await testAPI('Partners - Get All', 'GET', '/api/v1/partners', null, {}, true);
  await testAPI('Partners - Get Verified', 'GET', '/api/v1/partners/verified', null, {}, true);
  await testAPI('Partners - Get by Type', 'GET', '/api/v1/partners/type/hospital', null, {}, true);
  
  // Get partner by ID
  if (partnerId) {
    await testAPI(
      'Partners - Get by ID',
      'GET',
      `/api/v1/partners/${partnerId}`,
      null,
      {},
      true
    );
  }

  // Update Partner
  if (partnerId) {
    await testAPI(
      'Partners - Update',
      'PUT',
      `/api/v1/partners/${partnerId}`,
      {
        description: 'Updated description for City Hospital',
        isVerified: true,
      },
      {},
      true
    );
  }

  // ============================================
  // 17. CORPORATES CRUD
  // ============================================
  // Create Corporate
  const corporateTimestamp = Date.now();
  // Generate a 10-digit phone number: 98 + last 8 digits of timestamp
  const corporatePhoneSuffix = corporateTimestamp.toString().slice(-8).padStart(8, '0');
  const uniqueCorporatePhone = `98${corporatePhoneSuffix}`;
  await testAPI(
    'Corporates - Create',
    'POST',
    '/api/v1/corporates',
    {
      name: 'Tech Corp',
      companyName: 'Tech Corporation Pvt Ltd',
      industry: 'IT',
      email: `info.${corporateTimestamp}@techcorp.com`,
      phone: uniqueCorporatePhone, // 10-digit unique phone
      contactPerson: 'John Manager',
      address: '789 Corporate Avenue',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400002',
      country: 'India',
      domain: 'techcorp.com',
      website: 'https://techcorp.com',
      logoUrl: corporateImageUrl || '/api/static/corporates/techcorp-logo.png',
      employeeCount: 500,
      description: 'Leading IT services company',
      isActive: true,
      isVerified: true,
    },
    {},
    true
  );

  // Create more corporates
  const corporateTimestamp2 = Date.now() + 1;
  const corporatePhoneSuffix2 = corporateTimestamp2.toString().slice(-8).padStart(8, '0');
  const uniqueCorporatePhone2 = `98${corporatePhoneSuffix2}`;
  await testAPI(
    'Corporates - Create (Finance)',
    'POST',
    '/api/v1/corporates',
    {
      name: 'Finance Corp',
      companyName: 'Finance Corporation Ltd',
      industry: 'Finance',
      email: `info.${corporateTimestamp2}@financecorp.com`,
      phone: uniqueCorporatePhone2,
      contactPerson: 'Jane Director',
      address: '321 Business Park',
      city: 'Delhi',
      state: 'Delhi',
      pincode: '110001',
      country: 'India',
      domain: 'financecorp.com',
      website: 'https://financecorp.com',
      logoUrl: corporateImageUrl || '/api/static/corporates/financecorp-logo.png',
      employeeCount: 300,
      description: 'Leading financial services company',
      isActive: true,
      isVerified: true,
    },
    {},
    true
  );

  // Get Corporates
  await testAPI('Corporates - Get All', 'GET', '/api/v1/corporates', null, {}, true);
  await testAPI('Corporates - Get Verified', 'GET', '/api/v1/corporates/verified', null, {}, true);
  await testAPI('Corporates - Get by Industry', 'GET', '/api/v1/corporates/industry/IT', null, {}, true);
  await testAPI('Corporates - Get by City', 'GET', '/api/v1/corporates?city=Mumbai', null, {}, true);
  await testAPI('Corporates - Get by State', 'GET', '/api/v1/corporates?state=Maharashtra', null, {}, true);
  await testAPI('Corporates - Get by Country', 'GET', '/api/v1/corporates?country=India', null, {}, true);
  
  // Get corporate by ID
  if (corporateId) {
    await testAPI(
      'Corporates - Get by ID',
      'GET',
      `/api/v1/corporates/${corporateId}`,
      null,
      {},
      true
    );
  }

  // Update Corporate
  if (corporateId) {
    await testAPI(
      'Corporates - Update',
      'PUT',
      `/api/v1/corporates/${corporateId}`,
      {
        employeeCount: 600,
        description: 'Updated description for Tech Corp',
      },
      {},
      true
    );
  }

  // ============================================
  // 18. HR MODULE CRUD
  // ============================================
  // Create HR Employee Record
  const hrTimestamp = Date.now();
  const employeeIdValue = `EMP${hrTimestamp.toString().slice(-6)}`;
  await testAPI(
    'HR - Create',
    'POST',
    '/api/v1/hr',
    {
      employeeId: employeeIdValue,
      firstName: 'John',
      lastName: 'Employee',
      email: `john.${hrTimestamp}@techcorp.com`,
      phone: `98${hrTimestamp.toString().slice(-8).padStart(8, '0')}`,
      dateOfBirth: '19900115', // YYYYMMDD format
      gender: 'male',
      address: '123 Employee Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      country: 'India',
      department: 'IT',
      designation: 'Software Developer',
      employmentType: 'full-time',
      joiningDate: '20240101', // YYYYMMDD format
      employmentStatus: 'active',
      corporateId: corporateId || undefined,
      emergencyContactName: 'Jane Employee',
      emergencyContactPhone: '9876543210',
      emergencyContactRelation: 'Spouse',
      isActive: true,
    },
    {},
    true
  );

  // Create more HR records
  const hrTimestamp2 = Date.now() + 1;
  const employeeIdValue2 = `EMP${hrTimestamp2.toString().slice(-6)}`;
  await testAPI(
    'HR - Create (Manager)',
    'POST',
    '/api/v1/hr',
    {
      employeeId: employeeIdValue2,
      firstName: 'Sarah',
      lastName: 'Manager',
      email: `sarah.${hrTimestamp2}@techcorp.com`,
      phone: `98${hrTimestamp2.toString().slice(-8).padStart(8, '0')}`,
      dateOfBirth: '19850120',
      gender: 'female',
      address: '456 Manager Avenue',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400002',
      country: 'India',
      department: 'HR',
      designation: 'HR Manager',
      employmentType: 'full-time',
      joiningDate: '20230101',
      employmentStatus: 'active',
      corporateId: corporateId || undefined,
      isActive: true,
    },
    {},
    true
  );

  // Get HR Records
  await testAPI('HR - Get All', 'GET', '/api/v1/hr', null, {}, true);
  await testAPI('HR - Get by Department', 'GET', '/api/v1/hr/department/IT', null, {}, true);
  await testAPI('HR - Get by Status', 'GET', '/api/v1/hr/status/active', null, {}, true);
  if (corporateId) {
    await testAPI('HR - Get by Corporate', 'GET', `/api/v1/hr/corporate/${corporateId}`, null, {}, true);
  }
  
  // Get HR by ID
  if (hrId) {
    await testAPI(
      'HR - Get by ID',
      'GET',
      `/api/v1/hr/${hrId}`,
      null,
      {},
      true
    );
  }

  // Get HR by Employee ID
  if (employeeId) {
    await testAPI(
      'HR - Get by Employee ID',
      'GET',
      `/api/v1/hr/employee/${employeeId}`,
      null,
      {},
      true
    );
  }

  // Update HR Record
  if (hrId) {
    await testAPI(
      'HR - Update',
      'PUT',
      `/api/v1/hr/${hrId}`,
      {
        designation: 'Senior Software Developer',
        department: 'Engineering',
      },
      {},
      true
    );
  }

  // ============================================
  // 19. SLOTS CRUD
  // ============================================
  // Create Slot (for specialist)
  if (specialistId) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const slotDate = tomorrow.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD format

    await testAPI(
      'Slots - Create',
      'POST',
      '/api/v1/slots',
      {
        specialistId: specialistId,
        date: slotDate,
        startTime: '09:00 AM',
        endTime: '10:00 AM',
        duration: 60, // minutes
        maxBookings: 5,
        currentBookings: 0,
        isAvailable: true,
        slotType: 'consultation',
        isActive: true,
      },
      {},
      true
    );
  }

  // Get Slots
  await testAPI('Slots - Get All', 'GET', '/api/v1/slots', null, {}, true);
  await testAPI('Slots - Get Available', 'GET', '/api/v1/slots/available', null, {}, true);
  if (specialistId) {
    await testAPI(
      'Slots - Get by Specialist ID',
      'GET',
      `/api/v1/slots/specialist/${specialistId}`,
      null,
      {},
      true
    );
  }
  if (wellnessPackageId) {
    await testAPI(
      'Slots - Get by Wellness Package ID',
      'GET',
      `/api/v1/slots/wellness-package/${wellnessPackageId}`,
      null,
      {},
      true
    );
  }

  // Update Slot
  if (slotId) {
    await testAPI(
      'Slots - Update',
      'PUT',
      `/api/v1/slots/${slotId}`,
      {
        isAvailable: false,
        currentBookings: 1,
      },
      {},
      true
    );
  }

  // ============================================
  // 20. DELETE OPERATIONS (Cleanup)
  // ============================================
  // Delete Dependent
  if (dependentId && userId) {
    await testAPI(
      'Dependents - Delete',
      'DELETE',
      `/api/v1/dependents/${dependentId}?userId=${userId}`,
      null,
      {},
      true
    );
  }

  // Delete Partner
  if (partnerId) {
    await testAPI(
      'Partners - Delete',
      'DELETE',
      `/api/v1/partners/${partnerId}`,
      null,
      {},
      true
    );
  }

  // Delete Corporate
  if (corporateId) {
    await testAPI(
      'Corporates - Delete',
      'DELETE',
      `/api/v1/corporates/${corporateId}`,
      null,
      {},
      true
    );
  }

  // Delete HR Record
  if (hrId) {
    await testAPI(
      'HR - Delete',
      'DELETE',
      `/api/v1/hr/${hrId}`,
      null,
      {},
      true
    );
  }

  // Delete Slot
  if (slotId) {
    await testAPI(
      'Slots - Delete',
      'DELETE',
      `/api/v1/slots/${slotId}`,
      null,
      {},
      true
    );
  }

  // Users
  await testAPI('Users - Get All', 'GET', '/api/v1/users', null, {}, true);

  // ============================================
  // 21. WALLET APIs
  // ============================================
  if (userId) {
    // Get wallet (auto-created on login)
    const walletResult = await testAPI(
      'Wallet - Get by User ID',
      'GET',
      `/api/v1/wallet/user/${userId}`,
      null,
      {},
      true
    );
    if (walletResult.status === 'success' && walletResult.response?.data?._id) {
      walletId = walletResult.response.data._id;
    }

    // Add wallet credit transaction
    const walletCreditResult = await testAPI(
      'Wallet - Add Credit Transaction',
      'POST',
      '/api/v1/wallet/transactions',
      {
        userId: userId,
        transactionType: 'credit',
        amount: 1000,
        description: 'Welcome bonus',
        referenceType: 'promotion',
        notes: 'Initial credit for new user',
      },
      {},
      true
    );
    if (walletCreditResult.status === 'success' && walletCreditResult.response?.data?._id) {
      transactionId = walletCreditResult.response.data._id;
    }

    // Get wallet transactions
    await testAPI(
      'Wallet - Get Transactions',
      'GET',
      `/api/v1/wallet/user/${userId}/transactions`,
      null,
      {},
      true
    );

      // Get wallet transactions filtered
    await testAPI(
      'Wallet - Get Credit Transactions',
      'GET',
      `/api/v1/wallet/user/${userId}/transactions?transactionType=credit&page=1&limit=10`,
      null,
      {},
      true
    );
    
    // Get wallet by ID
    if (walletId) {
      await testAPI(
        'Wallet - Get by ID',
        'GET',
        `/api/v1/wallet/${walletId}`,
        null,
        {},
        true
      );
    }
    
    // Get transaction by ID
    if (transactionId) {
      await testAPI(
        'Wallet - Get Transaction by ID',
        'GET',
        `/api/v1/wallet/transactions/${transactionId}`,
        null,
        {},
        true
      );
    }
  }

  // Get all wallets
  await testAPI('Wallet - Get All', 'GET', '/api/v1/wallet', null, {}, true);

  // ============================================
  // 22. COUPON APIs (Additional Tests)
  // ============================================
  // Note: Coupons are created earlier (section 8) so they can be used in bookings

  // Get all coupons
  await testAPI('Coupons - Get All', 'GET', '/api/v1/coupons', null, {}, true);

  // Get active coupons
  await testAPI('Coupons - Get Active', 'GET', '/api/v1/coupons/active', null, {}, true);

  // Get applicable coupons
  await testAPI(
    'Coupons - Get Applicable (Package)',
    'GET',
    '/api/v1/coupons/applicable?bookingType=package',
    null,
    {},
    true
  );

  // Validate coupon
  if (userId && wellnessPackageId) {
    await testAPI(
      'Coupons - Validate',
      'POST',
      '/api/v1/coupons/validate',
      {
        code: couponCode,
        userId: userId,
        bookingType: 'package',
        bookingId: wellnessPackageId,
        purchaseAmount: 2999,
      },
      {},
      true
    );
  }

  // Get coupon by code
  await testAPI(
    'Coupons - Get by Code',
    'GET',
    `/api/v1/coupons/code/${couponCode}`,
    null,
    {},
    true
  );
  
  // Get coupon by ID
  if (couponId) {
    await testAPI(
      'Coupons - Get by ID',
      'GET',
      `/api/v1/coupons/${couponId}`,
      null,
      {},
      true
    );
  }

  // Update coupon
  if (couponId) {
    await testAPI(
      'Coupons - Update',
      'PUT',
      `/api/v1/coupons/${couponId}`,
      {
        discountValue: 25,
        maximumDiscountAmount: 1500,
      },
      {},
      true
    );
  }

  // ============================================
  // 23. NOTIFICATION APIs
  // ============================================
  if (userId) {
    // Get user notifications (should have login and booking notifications)
    const notificationsResult = await testAPI(
      'Notifications - Get by User ID',
      'GET',
      `/api/v1/notifications/user/${userId}`,
      null,
      {},
      true
    );
    if (notificationsResult.status === 'success' && notificationsResult.response?.data?.[0]?._id) {
      notificationId = notificationsResult.response.data[0]._id;
    }

    // Get unread notifications
    await testAPI(
      'Notifications - Get Unread',
      'GET',
      `/api/v1/notifications/user/${userId}/unread`,
      null,
      {},
      true
    );

    // Get unread count
    await testAPI(
      'Notifications - Get Unread Count',
      'GET',
      `/api/v1/notifications/user/${userId}/unread-count`,
      null,
      {},
      true
    );

    // Mark notification as read
    if (notificationId) {
      await testAPI(
        'Notifications - Mark as Read',
        'PATCH',
        `/api/v1/notifications/${notificationId}/read`,
        null,
        {},
        true
      );
    }

    // Mark all notifications as read
    await testAPI(
      'Notifications - Mark All as Read',
      'PATCH',
      `/api/v1/notifications/user/${userId}/read-all`,
      null,
      {},
      true
    );
  }

  // Get all notifications
  await testAPI('Notifications - Get All', 'GET', '/api/v1/notifications', null, {}, true);
  
  // Get notification by ID
  if (notificationId) {
    await testAPI(
      'Notifications - Get by ID',
      'GET',
      `/api/v1/notifications/${notificationId}`,
      null,
      {},
      true
    );
  }

  // Create a test notification
  if (userId) {
    await testAPI(
      'Notifications - Create',
      'POST',
      '/api/v1/notifications',
      {
        userId: userId,
        type: 'general',
        title: 'Test Notification',
        message: 'This is a test notification created via API',
        data: { test: true },
      },
      {},
      true
    );
  }

  // ============================================
  // 24. BANNER APIs
  // ============================================
  // Create banner
  const bannerResult = await testAPI(
    'Banners - Create',
    'POST',
    '/api/v1/banners',
    {
      title: 'Summer Health Checkup',
      description: 'Get 30% off on all health packages this summer',
      imageUrl: bannerImageUrl || '/api/static/banners/summer-banner.jpg',
      linkUrl: '/packages',
      bannerType: 'promotional',
      startDate: '20250101',
      endDate: '20250331',
      target: 'wellnessPackage',
      targetId: wellnessPackageId || undefined,
      isActive: true,
      order: 1,
    },
    {},
    true
  );

  // Get all banners
  await testAPI('Banners - Get All', 'GET', '/api/v1/banners', null, {}, true);

  // Get active banners
  await testAPI('Banners - Get Active', 'GET', '/api/v1/banners/active', null, {}, true);

  // Get banners by type
  await testAPI(
    'Banners - Get by Type',
    'GET',
    '/api/v1/banners/type/promotional',
    null,
    {},
    true
  );
  
  // Extract banner ID and test GET by ID
  let bannerId: string | null = null;
  if (bannerResult.status === 'success' && bannerResult.response?.data?._id) {
    bannerId = bannerResult.response.data._id;
    await testAPI(
      'Banners - Get by ID',
      'GET',
      `/api/v1/banners/${bannerId}`,
      null,
      {},
      true
    );
  }

  // ============================================
  // 25. FILE FETCH API
  // ============================================
  // Test file fetch with a sample path (this will fail if file doesn't exist, but tests the endpoint)
  await testAPI(
    'File - Fetch',
    'GET',
    '/api/v1/file/fetch?url=/api/static/bookings/test/document.pdf',
    null,
    {},
    true
  );
  
  // Test static file serving endpoint
  await testAPI(
    'File - Static Serve',
    'GET',
    '/api/static/bookings/test/document.pdf',
    null,
    {},
    false // Static files don't require auth
  );

  // File Upload tests are now done at the beginning of the test suite
  // after authentication, so we skip this duplicate test
  
  // ============================================
  // 26. ADDITIONAL EDGE CASE TESTS
  // ============================================
  // Test invalid endpoints
  await testAPI(
    '404 - Invalid Endpoint',
    'GET',
    '/api/v1/invalid-endpoint',
    null,
    {},
    true
  );
  
  // Test wallet debit transaction (if wallet has balance)
  if (userId && walletId) {
    await testAPI(
      'Wallet - Add Debit Transaction',
      'POST',
      '/api/v1/wallet/transactions',
      {
        userId: userId,
        transactionType: 'debit',
        amount: 100,
        description: 'Test debit transaction',
        referenceType: 'booking',
        referenceId: bookingId || 'test-booking-id',
        notes: 'Test debit for booking',
      },
      {},
      true
    );
  }
  
  // Test coupon validation with invalid code (valid format but doesn't exist)
  await testAPI(
    'Coupons - Validate Invalid Code',
    'POST',
    '/api/v1/coupons/validate',
    {
      code: 'INVALIDCODE99999',
      userId: userId || 'test-user-id',
      bookingType: 'package',
      purchaseAmount: 2999,
    },
    {},
    true
  );
  
  // Test booking update
  if (bookingId) {
    await testAPI(
      'Bookings - Update',
      'PUT',
      `/api/v1/bookings/${bookingId}`,
      {
        status: 'confirmed',
        notes: 'Updated booking notes from API test',
      },
      {},
      true
    );
  }
  
  // Test specialist update
  if (specialistId) {
    await testAPI(
      'Specialists - Update',
      'PUT',
      `/api/v1/specialists/${specialistId}`,
      {
        rating: 4.9,
        bio: 'Updated bio from API test suite',
      },
      {},
      true
    );
  }
  
  // Test wellness package update
  if (wellnessPackageId) {
    await testAPI(
      'Wellness Packages - Update',
      'PUT',
      `/api/v1/wellness-packages/${wellnessPackageId}`,
      {
        discountedPrice: 2799,
        isPopular: true,
      },
      {},
      true
    );
  }
  
  // Test health tip update
  if (healthTipId) {
    await testAPI(
      'Health Tips - Update',
      'PUT',
      `/api/v1/health-tips/${healthTipId}`,
      {
        isActive: false,
      },
      {},
      true
    );
  } else {
    console.log('⚠️  Skipping Health Tip Update - No healthTipId available');
  }

  // Save results
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Test Summary:');
  const successCount = results.tests.filter((t) => t.status === 'success').length;
  const errorCount = results.tests.filter((t) => t.status === 'error').length;
  const skippedCount = results.tests.filter((t) => t.status === 'skipped').length;

  console.log(`✅ Success: ${successCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  console.log(`⏭️  Skipped: ${skippedCount}`);
  if (results.authToken) {
    console.log(`🔑 Auth Token: ${results.authToken.substring(0, 30)}...`);
  }
  
  // Print detailed error summary
  if (errorCount > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('\n❌ Error Details:');
    results.tests
      .filter((t) => t.status === 'error')
      .forEach((test, index) => {
        console.log(`\n${index + 1}. ${test.name}`);
        console.log(`   URL: ${test.method} ${test.url}`);
        console.log(`   Status: ${test.statusCode}`);
        if (test.error) {
          console.log(`   Message: ${test.error.message || test.error.fullError || 'Unknown error'}`);
          if (test.error.code) {
            console.log(`   Code: ${test.error.code}`);
          }
          if (test.error.response && typeof test.error.response === 'object') {
            const errorStr = JSON.stringify(test.error.response, null, 2);
            if (errorStr.length < 300) {
              console.log(`   Response: ${errorStr}`);
            } else {
              console.log(`   Response: ${errorStr.substring(0, 300)}...`);
            }
          }
        }
      });
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`📁 Results saved to: ${RESULTS_FILE}`);
  console.log('\n');
}

// Run tests
runTests().catch((error: Error) => {
  console.error('Test execution failed:', error);
  process.exit(1);
});
