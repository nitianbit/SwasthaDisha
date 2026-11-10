import { Service } from 'typedi';
import { FileService } from '@/modules/file/services';
import { IDocument } from '../types';

@Service()
export class BookingDocumentService {
  constructor(private fileService: FileService) {}

  /**
   * Upload documents for a booking
   * @param req - Express request with multipart/form-data
   * @param bookingId - The booking ID
   * @returns Array of uploaded document objects
   */
  async uploadBookingDocuments(
    req: any,
    bookingId: string
  ): Promise<IDocument[]> {
    const uploadedFiles = await this.fileService.uploadFiles(
      req,
      'bookings',
      bookingId
    );

    // Map uploaded files to document format
    return uploadedFiles.map((file) => {
      // Determine document type based on file name or mime type
      let type: 'report' | 'prescription' | 'other' = 'other';
      
      if (file.mimeType === 'application/pdf' || file.mimeType === 'application/octet-stream') {
        // Could be report or prescription, default to report
        type = 'report';
      } else if (file.originalFileName.toLowerCase().includes('prescription')) {
        type = 'prescription';
      } else if (file.originalFileName.toLowerCase().includes('report')) {
        type = 'report';
      }

      return {
        type,
        url: file.url,
        fileName: file.fileName,
      };
    });
  }

  /**
   * Delete a document from a booking
   * @param documentUrl - The URL of the document to delete
   */
  async deleteBookingDocument(documentUrl: string): Promise<void> {
    await this.fileService.deleteFile(documentUrl);
  }
}
