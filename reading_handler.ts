import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "./types.d.ts";

/**
 * Unified reading management function that handles book reading, history, search, and settings
 * through a modal interface.
 *
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @param mode - The reading operation mode: "History", "Read", "Search", or "Settings"
 * @param action - The action to perform within the selected mode
 * @param bookName - Name of the book (required for History, Read, Search modes)
 * @param pageNumber - Page number for Read mode with "GoTo" action
 * @param keyword - Search keyword for Search mode
 * @param readingMode - Reading mode for Settings ("paragraphs", "sentences", "fullpage")
 * @param readingAmount - Amount to read (number of paragraphs/sentences)
 * @returns An object containing success status and relevant data or error message
 */
export async function ReadingManager(
    supabase: SupabaseClient,
    userId: string,
    mode: "History" | "Read" | "Search" | "Settings",
    action: string,
    bookName?: string | null,
    pageNumber?: number | null,
    keyword?: string | null,
    readingMode?: "paragraphs" | "sentences" | "fullpage" | null,
    readingAmount?: number | null
): Promise<{ success: boolean; data?: any; message: string }> {
    console.log(`ReadingManager called: mode=${mode}, action=${action}, userId=${userId}, bookName=${bookName}`);

    // Validate mode and action
    if (!["History", "Read", "Search", "Settings"].includes(mode)) {
        return { success: false, message: "Invalid mode. Must be 'History', 'Read', 'Search', or 'Settings'." };
    }

    try {
        // Handle History mode
        if (mode === "History") {
            if (action === "Check") {
                if (!bookName || typeof bookName !== 'string') {
                    return { success: false, message: "bookName is required for History Check." };
                }
                return await getReadingHistory(supabase, userId, bookName);
            } else {
                return { success: false, message: "Invalid action for History mode. Use 'Check'." };
            }
        }

        // Handle Read mode
        else if (mode === "Read") {
            if (!bookName || typeof bookName !== 'string') {
                return { success: false, message: "bookName is required for Read mode." };
            }

            if (action === "Continue") {
                return await continueReading(supabase, userId, bookName);
            } else if (action === "Start") {
                return await startReading(supabase, userId, bookName);
            } else if (action === "GoTo") {
                if (typeof pageNumber !== 'number' || pageNumber < 1) {
                    return { success: false, message: "Valid pageNumber is required for Read GoTo action." };
                }
                return await readSpecificPage(supabase, userId, bookName, pageNumber);
            } else {
                return { success: false, message: "Invalid action for Read mode. Use 'Continue', 'Start', or 'GoTo'." };
            }
        }

        // Handle Search mode
        else if (mode === "Search") {
            if (action === "Find") {
                if (!bookName || typeof bookName !== 'string') {
                    return { success: false, message: "bookName is required for Search Find." };
                }
                if (!keyword || typeof keyword !== 'string') {
                    return { success: false, message: "keyword is required for Search Find." };
                }
                return await searchInBook(supabase, userId, bookName, keyword);
            } else {
                return { success: false, message: "Invalid action for Search mode. Use 'Find'." };
            }
        }

        // Handle Settings mode
        else if (mode === "Settings") {
            if (action === "Get") {
                return await getReadingSettings(supabase, userId);
            } else if (action === "Set") {
                if (!readingMode || !["paragraphs", "sentences", "fullpage"].includes(readingMode)) {
                    return { success: false, message: "Valid readingMode is required for Settings Set." };
                }
                if (readingMode !== "fullpage" && (typeof readingAmount !== 'number' || readingAmount < 1)) {
                    return { success: false, message: "Valid readingAmount is required for paragraphs/sentences mode." };
                }
                return await setReadingSettings(supabase, userId, readingMode, readingAmount || 1);
            } else {
                return { success: false, message: "Invalid action for Settings mode. Use 'Get' or 'Set'." };
            }
        }

        return { success: false, message: "Invalid mode/action combination." };

    } catch (err) {
        console.error(`Unexpected error in ReadingManager for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Get reading history for a specific book
 */
async function getReadingHistory(
    supabase: SupabaseClient,
    userId: string,
    bookName: string
): Promise<{ success: boolean; data?: any; message: string }> {
    try {
        const { data, error } = await supabase
            .from('reading_history')
            .select('*')
            .eq('user_id', userId)
            .eq('book_name', bookName)
            .maybeSingle();

        if (error) {
            console.error(`Error getting reading history:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            return {
                success: true,
                data: { hasHistory: false, currentPage: 0, totalPages: 0 },
                message: `No reading history found for "${bookName}". This book hasn't been read yet.`
            };
        }

        return {
            success: true,
            data: {
                hasHistory: true,
                currentPage: data.current_page,
                totalPages: data.total_pages,
                lastReadAt: data.last_read_at
            },
            message: `Reading history found for "${bookName}". Currently on page ${data.current_page} of ${data.total_pages}.`
        };

    } catch (err) {
        console.error(`Error in getReadingHistory:`, err);
        return { success: false, message: `Error retrieving reading history: ${err}` };
    }
}

/**
 * Continue reading from last position
 */
async function continueReading(
    supabase: SupabaseClient,
    userId: string,
    bookName: string
): Promise<{ success: boolean; data?: any; message: string }> {
    // First get reading history
    const historyResult = await getReadingHistory(supabase, userId, bookName);
    if (!historyResult.success) {
        return historyResult;
    }

    const { hasHistory, currentPage } = historyResult.data;
    
    if (!hasHistory) {
        return { success: false, message: `No reading history found for "${bookName}". Use "Start" action to begin reading.` };
    }

    // Read from current page
    return await readSpecificPage(supabase, userId, bookName, currentPage);
}

/**
 * Start reading from the beginning
 */
async function startReading(
    supabase: SupabaseClient,
    userId: string,
    bookName: string
): Promise<{ success: boolean; data?: any; message: string }> {
    return await readSpecificPage(supabase, userId, bookName, 1);
}

/**
 * Read a specific page from a book
 */
async function readSpecificPage(
    supabase: SupabaseClient,
    userId: string,
    bookName: string,
    pageNumber: number
): Promise<{ success: boolean; data?: any; message: string }> {
    try {
        // Get user's reading settings
        const settingsResult = await getReadingSettings(supabase, userId);
        const settings = settingsResult.success ? settingsResult.data : { readingMode: "fullpage", readingAmount: 1 };

        // Read the book content
        const content = await readBookContent(bookName, pageNumber, settings.readingMode, settings.readingAmount);
        if (!content.success) {
            return content;
        }

        // Update reading progress
        await updateReadingProgress(supabase, userId, bookName, pageNumber, content.data.totalPages);

        return {
            success: true,
            data: {
                content: content.data.content,
                currentPage: pageNumber,
                totalPages: content.data.totalPages,
                readingMode: settings.readingMode,
                readingAmount: settings.readingAmount
            },
            message: `Reading "${bookName}" - Page ${pageNumber} of ${content.data.totalPages}`
        };

    } catch (err) {
        console.error(`Error in readSpecificPage:`, err);
        return { success: false, message: `Error reading book: ${err}` };
    }
}

/**
 * Parse book content with navigation markers
 */
function parseBookWithMarkers(content: string): { pages: Array<{ pageNum: number; content: string; chapter?: string; sections?: string[] }>, totalPages: number } {
    const lines = content.split('\n');
    const pages: Array<{ pageNum: number; content: string; chapter?: string; sections?: string[] }> = [];

    let currentPage: { pageNum: number; content: string; chapter?: string; sections?: string[] } | null = null;
    let currentChapter: string | undefined = undefined;
    let currentSections: string[] = [];

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Check for page marker
        const pageMatch = trimmedLine.match(/^\[PAGE:(\d+)\]$/);
        if (pageMatch) {
            // Save previous page if exists
            if (currentPage) {
                pages.push(currentPage);
            }

            // Start new page
            currentPage = {
                pageNum: parseInt(pageMatch[1]),
                content: "",
                chapter: currentChapter,
                sections: [...currentSections]
            };
            continue;
        }

        // Check for chapter marker
        const chapterMatch = trimmedLine.match(/^\[CHAPTER:(.+)\]$/);
        if (chapterMatch) {
            currentChapter = chapterMatch[1];
            currentSections = []; // Reset sections for new chapter
            if (currentPage) {
                currentPage.chapter = currentChapter;
            }
            continue;
        }

        // Check for section marker
        const sectionMatch = trimmedLine.match(/^\[SECTION:(.+)\]$/);
        if (sectionMatch) {
            currentSections.push(sectionMatch[1]);
            if (currentPage) {
                currentPage.sections = [...currentSections];
            }
            continue;
        }

        // Regular content
        if (currentPage && trimmedLine) {
            if (currentPage.content) {
                currentPage.content += '\n' + line;
            } else {
                currentPage.content = line;
            }
        }
    }

    // Add last page
    if (currentPage) {
        pages.push(currentPage);
    }

    return { pages, totalPages: pages.length };
}

/**
 * Read book content from file system with marker support
 */
async function readBookContent(
    bookName: string,
    pageNumber: number,
    readingMode: string,
    readingAmount: number
): Promise<{ success: boolean; data?: any; message: string }> {
    try {
        // Try public library first, then private, then PDF processed output
        const publicPath = `books/public/${bookName}.txt`;
        const privatePath = `books/private/${bookName}.txt`;
        const pdfPath = `books/pdf_processing/output/${bookName}.txt`;

        let content: string;
        let hasMarkers = false;

        try {
            content = await Deno.readTextFile(pdfPath);
            hasMarkers = true; // PDF processed files have markers
        } catch {
            try {
                content = await Deno.readTextFile(publicPath);
            } catch {
                try {
                    content = await Deno.readTextFile(privatePath);
                } catch {
                    return { success: false, message: `Book "${bookName}" not found in library.` };
                }
            }
        }

        let pages: Array<{ pageNum: number; content: string; chapter?: string; sections?: string[] }>;
        let totalPages: number;

        if (hasMarkers) {
            // Parse content with markers
            const parsed = parseBookWithMarkers(content);
            pages = parsed.pages;
            totalPages = parsed.totalPages;
        } else {
            // Legacy format - split by double line breaks
            const legacyPages = content.split('\n\n').filter(page => page.trim().length > 0);
            pages = legacyPages.map((pageContent, index) => ({
                pageNum: index + 1,
                content: pageContent
            }));
            totalPages = pages.length;
        }

        if (pageNumber > totalPages) {
            return { success: false, message: `Page ${pageNumber} does not exist. Book has ${totalPages} pages.` };
        }

        const targetPage = pages.find(p => p.pageNum === pageNumber);
        if (!targetPage) {
            return { success: false, message: `Page ${pageNumber} not found.` };
        }

        let pageContent = targetPage.content;

        // Apply reading mode
        if (readingMode === "paragraphs") {
            const paragraphs = pageContent.split('\n').filter(p => p.trim().length > 0);
            pageContent = paragraphs.slice(0, readingAmount).join('\n');
        } else if (readingMode === "sentences") {
            const sentences = pageContent.split(/[.!?]+/).filter(s => s.trim().length > 0);
            pageContent = sentences.slice(0, readingAmount).join('. ') + (sentences.length > readingAmount ? '.' : '');
        }
        // fullpage mode uses the entire page content

        return {
            success: true,
            data: {
                content: pageContent,
                totalPages: totalPages,
                chapter: targetPage.chapter,
                sections: targetPage.sections,
                hasMarkers: hasMarkers
            },
            message: "Content retrieved successfully"
        };

    } catch (err) {
        console.error(`Error reading book content:`, err);
        return { success: false, message: `Error reading book file: ${err}` };
    }
}

/**
 * Update reading progress in database
 */
async function updateReadingProgress(
    supabase: SupabaseClient,
    userId: string,
    bookName: string,
    currentPage: number,
    totalPages: number
): Promise<void> {
    try {
        const { error } = await supabase
            .from('reading_history')
            .upsert({
                user_id: userId,
                book_name: bookName,
                current_page: currentPage,
                total_pages: totalPages,
                last_read_at: new Date().toISOString()
            }, {
                onConflict: 'user_id,book_name'
            });

        if (error) {
            console.error(`Error updating reading progress:`, error);
        }
    } catch (err) {
        console.error(`Error in updateReadingProgress:`, err);
    }
}

/**
 * Search for keywords in a book with marker support
 */
async function searchInBook(
    supabase: SupabaseClient,
    userId: string,
    bookName: string,
    keyword: string
): Promise<{ success: boolean; data?: any; message: string }> {
    try {
        // Try PDF processed output first, then public, then private
        const pdfPath = `books/pdf_processing/output/${bookName}.txt`;
        const publicPath = `books/public/${bookName}.txt`;
        const privatePath = `books/private/${bookName}.txt`;

        let content: string;
        let hasMarkers = false;

        try {
            content = await Deno.readTextFile(pdfPath);
            hasMarkers = true;
        } catch {
            try {
                content = await Deno.readTextFile(publicPath);
            } catch {
                try {
                    content = await Deno.readTextFile(privatePath);
                } catch {
                    return { success: false, message: `Book "${bookName}" not found in library.` };
                }
            }
        }

        const results: Array<{ page: number; context: string; chapter?: string; sections?: string[] }> = [];

        if (hasMarkers) {
            // Parse content with markers for more accurate search
            const parsed = parseBookWithMarkers(content);

            parsed.pages.forEach((page) => {
                if (page.content.toLowerCase().includes(keyword.toLowerCase())) {
                    // Get context around the keyword
                    const sentences = page.content.split(/[.!?]+/);
                    const matchingSentences = sentences.filter(sentence =>
                        sentence.toLowerCase().includes(keyword.toLowerCase())
                    );

                    results.push({
                        page: page.pageNum,
                        context: matchingSentences.join('. ').trim(),
                        chapter: page.chapter,
                        sections: page.sections
                    });
                }
            });
        } else {
            // Legacy search for non-marked content
            const pages = content.split('\n\n').filter(page => page.trim().length > 0);

            pages.forEach((pageContent, index) => {
                if (pageContent.toLowerCase().includes(keyword.toLowerCase())) {
                    // Get context around the keyword
                    const sentences = pageContent.split(/[.!?]+/);
                    const matchingSentences = sentences.filter(sentence =>
                        sentence.toLowerCase().includes(keyword.toLowerCase())
                    );

                    results.push({
                        page: index + 1,
                        context: matchingSentences.join('. ').trim()
                    });
                }
            });
        }

        if (results.length === 0) {
            return {
                success: true,
                data: { results: [], count: 0, hasMarkers },
                message: `Không tìm thấy từ khóa "${keyword}" trong "${bookName}".`
            };
        }

        return {
            success: true,
            data: { results: results, count: results.length, hasMarkers },
            message: `Tìm thấy ${results.length} kết quả cho từ khóa "${keyword}" trong "${bookName}".`
        };

    } catch (err) {
        console.error(`Error in searchInBook:`, err);
        return { success: false, message: `Lỗi khi tìm kiếm trong sách: ${err}` };
    }
}

/**
 * Get user's reading settings
 */
async function getReadingSettings(
    supabase: SupabaseClient,
    userId: string
): Promise<{ success: boolean; data?: any; message: string }> {
    try {
        const { data, error } = await supabase
            .from('reading_settings')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error(`Error getting reading settings:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            // Return default settings
            return {
                success: true,
                data: { readingMode: "fullpage", readingAmount: 1 },
                message: "Using default reading settings: full page mode."
            };
        }

        return {
            success: true,
            data: { readingMode: data.reading_mode, readingAmount: data.reading_amount },
            message: `Current reading settings: ${data.reading_mode} mode${data.reading_mode !== 'fullpage' ? ` (${data.reading_amount})` : ''}.`
        };

    } catch (err) {
        console.error(`Error in getReadingSettings:`, err);
        return { success: false, message: `Error retrieving reading settings: ${err}` };
    }
}

/**
 * Set user's reading settings
 */
async function setReadingSettings(
    supabase: SupabaseClient,
    userId: string,
    readingMode: "paragraphs" | "sentences" | "fullpage",
    readingAmount: number
): Promise<{ success: boolean; data?: any; message: string }> {
    try {
        const { error } = await supabase
            .from('reading_settings')
            .upsert({
                user_id: userId,
                reading_mode: readingMode,
                reading_amount: readingAmount,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'user_id'
            });

        if (error) {
            console.error(`Error setting reading settings:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        return {
            success: true,
            message: `Reading settings updated: ${readingMode} mode${readingMode !== 'fullpage' ? ` (${readingAmount})` : ''}.`
        };

    } catch (err) {
        console.error(`Error in setReadingSettings:`, err);
        return { success: false, message: `Error updating reading settings: ${err}` };
    }
}
